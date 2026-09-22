import ky from "ky";
import { z } from "zod";

const httpMethod = z.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE", "CONNECT"]);
const metadataSchema = z.object({
  description: z.string().default(""),
}).catchall(z.json());

type Metadata = z.infer<typeof metadataSchema>;
type SchemaNode = {
  readonly path: string;
  readonly info?: Partial<Record<z.infer<typeof httpMethod>, Metadata>> | undefined;
  readonly children?: SchemaNode[] | undefined;
};
type Endpoint = Metadata & {
  readonly path: string;
  readonly method: string;
};
type PendingLoad = {
  readonly controller: AbortController;
  promise: Promise<readonly Endpoint[]>;
  consumers: number;
};

const nodeSchema: z.ZodType<SchemaNode> = z.lazy(() => z.object({
  path: z.string().startsWith("/"),
  info: z.partialRecord(httpMethod, metadataSchema).optional(),
  children: z.array(nodeSchema).optional(),
}));
const treeSchema = z.array(nodeSchema);
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

class CatalogError extends Error {
  constructor(readonly code: "fetch" | "schema" | "not_found" | "aborted") {
    const messages = {
      fetch: "Unable to download API catalog.",
      schema: "Invalid API catalog schema.",
      not_found: "Endpoint not found in API catalog.",
      aborted: "API catalog request aborted.",
    };
    super(messages[code]);
    this.name = "CatalogError";
  }
}

function parseSource(source: string): SchemaNode[] {
  const text = source.trim();
  const assignment = /^(?:const|let|var)\s+(?:apiSchema|pveapi)\s*=\s*/.exec(text);
  let json = text;
  if (assignment) {
    const start = assignment[0].length;
    if (text[start] !== "[") throw new CatalogError("schema");
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let end = -1;
    // Locate the array terminator without interpreting any JavaScript.
    for (let index = start; index < text.length; index++) {
      const character = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') {
        quoted = true;
      } else if (character === "[") {
        depth++;
      } else if (character === "]") {
        depth--;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end === -1 || !/^\s*;/.test(text.slice(end))) throw new CatalogError("schema");
    json = text.slice(start, end);
  }
  try {
    const value: unknown = JSON.parse(json);
    return treeSchema.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) throw new CatalogError("schema");
    throw error;
  }
}

async function readCatalog(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_CATALOG_BYTES) throw new CatalogError("fetch");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_CATALOG_BYTES) {
        await reader.cancel();
        throw new CatalogError("fetch");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const source = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    source.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(source);
}

function flatten(nodes: readonly SchemaNode[]): Endpoint[] {
  const endpoints: Endpoint[] = [];
  for (const node of nodes) {
    for (const [method, metadata] of Object.entries(node.info ?? {})) {
      endpoints.push({ ...metadata, path: node.path, method });
    }
    endpoints.push(...flatten(node.children ?? []));
  }
  return endpoints;
}

export class ApiCatalog {
  private endpoints: readonly Endpoint[] | undefined;
  private pending: PendingLoad | undefined;

  constructor(private readonly schemaUrl: string) {}

  private async loadUncached(signal: AbortSignal): Promise<readonly Endpoint[]> {
    // Unlike the HTTP header timeout, this also bounds reading the response body.
    const deadline = AbortSignal.timeout(15_000);
    const combinedSignal = AbortSignal.any([signal, deadline]);
    let source: string;
    try {
      const response = await ky.get(this.schemaUrl, {
        retry: 0,
        timeout: 15_000,
        signal: combinedSignal,
        credentials: "omit",
        redirect: "error",
      });
      source = await readCatalog(response);
    } catch {
      // The network boundary deliberately discards URL, body and abort-reason details.
      throw new CatalogError(signal?.aborted ? "aborted" : "fetch");
    }
    const endpoints = flatten(parseSource(source));
    this.endpoints = endpoints;
    return endpoints;
  }

  private beginLoad(): PendingLoad {
    const controller = new AbortController();
    const pending: PendingLoad = {
      controller,
      consumers: 0,
      promise: Promise.resolve([]),
    };
    pending.promise = this.loadUncached(controller.signal).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }

  private async waitForLoad(pending: PendingLoad, signal?: AbortSignal): Promise<readonly Endpoint[]> {
    pending.consumers++;
    let removeAbortListener: (() => void) | undefined;
    try {
      if (!signal) return await pending.promise;
      if (signal.aborted) throw new CatalogError("aborted");
      const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(new CatalogError("aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      });
      return await Promise.race([pending.promise, aborted]);
    } finally {
      removeAbortListener?.();
      pending.consumers--;
      if (pending.consumers === 0 && this.pending === pending && !this.endpoints) {
        this.pending = undefined;
      }
    }
  }

  private async load(signal?: AbortSignal): Promise<readonly Endpoint[]> {
    if (signal?.aborted) throw new CatalogError("aborted");
    if (this.endpoints) return this.endpoints;
    return this.waitForLoad(this.pending ?? this.beginLoad(), signal);
  }

  async search(query: string, method: string | undefined, offset: number, limit: number, signal?: AbortSignal) {
    const endpoints = await this.load(signal);
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const normalizedMethod = method?.toUpperCase();
    const matches = endpoints.filter((endpoint) => {
      if (normalizedMethod && endpoint.method !== normalizedMethod) return false;
      const searchable = `${endpoint.path} ${endpoint.method} ${endpoint.description}`.toLowerCase();
      return words.every((word) => searchable.includes(word));
    });
    const source = new URL(this.schemaUrl);
    source.username = "";
    source.password = "";
    source.search = "";
    source.hash = "";
    return {
      source: source.href,
      total: matches.length,
      offset,
      endpoints: matches.slice(offset, offset + limit).map((endpoint) => ({
        path: endpoint.path,
        method: endpoint.method,
        description: endpoint.description,
        ...(endpoint["allowtoken"] === undefined ? {} : { allowtoken: endpoint["allowtoken"] }),
      })),
    };
  }

  async describe(path: string, method: string, signal?: AbortSignal): Promise<Endpoint> {
    const endpoints = await this.load(signal);
    const candidates = endpoints.filter((endpoint) => endpoint.method === method.toUpperCase());
    const exact = candidates.find((endpoint) => endpoint.path === path);
    if (exact) return structuredClone(exact);
    const segments = path.split("/");
    const match = candidates.find((endpoint) => {
      const template = endpoint.path.split("/");
      return template.length === segments.length && template.every((segment, index) =>
        segment === segments[index] || (/^\{[^{}]+\}$/.test(segment) && Boolean(segments[index])),
      );
    });
    if (!match) throw new CatalogError("not_found");
    return structuredClone(match);
  }
}
