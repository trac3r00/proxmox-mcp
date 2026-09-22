import ky from "ky";
import { z } from "zod";
import type { Config } from "./config.js";

export const methodSchema = z.enum(["GET", "POST", "PUT", "DELETE"]);
const scalarSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
export const parametersSchema = z.record(z.string(), z.union([scalarSchema, z.array(scalarSchema)]));
export type Method = z.infer<typeof methodSchema>;
export type Parameters = z.infer<typeof parametersSchema>;
const MAX_API_BODY_BYTES = 512 * 1024;
const MAX_ERROR_BODY_BYTES = 16 * 1024;

export class ProxmoxError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ProxmoxError";
  }
}

export class ProxmoxClient {
  constructor(private readonly config: Config) {}

  redact(text: string): string {
    let result = text;
    for (const value of [this.config.tokenSecret, this.config.tokenId]) {
      result = result.replaceAll(value, "[REDACTED]").replaceAll(encodeURIComponent(value), "[REDACTED]");
    }
    return result;
  }

  private url(path: string): URL {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch (error) {
      if (error instanceof URIError) throw new ProxmoxError("Invalid API path encoding");
      throw error;
    }
    if (!path.startsWith("/") || path.startsWith("//")
      || /[\\?#\u0000-\u001f\u007f]/u.test(decoded) || decoded.includes("%")
      || decoded.split("/").some((segment) => segment === "." || segment === "..")
      || path.startsWith("/api2/")) {
      throw new ProxmoxError("Use an API-relative path such as /nodes, without queries or traversal");
    }
    return new URL(`${this.config.baseUrl}/api2/json${path}`);
  }

  private encode(parameters: Parameters): URLSearchParams {
    const encoded = new URLSearchParams();
    for (const [key, value] of Object.entries(parameters)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        encoded.append(key, typeof item === "boolean" ? (item ? "1" : "0") : String(item));
      }
    }
    return encoded;
  }

  private async readText(response: Response, maximumBytes: number): Promise<string> {
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > maximumBytes) {
      throw new ProxmoxError("Proxmox response body exceeds the safe MCP output limit");
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maximumBytes) {
          await reader.cancel();
          throw new ProxmoxError("Proxmox response body exceeds the safe MCP output limit");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const text = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      text.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(text);
  }

  async text(response: Response): Promise<string> {
    return this.readText(response, MAX_API_BODY_BYTES);
  }

  async response(
    method: Method,
    path: string,
    parameters: Parameters = {},
    signal?: AbortSignal,
    multipart?: FormData,
  ): Promise<Response> {
    const url = this.url(path);
    const encoded = this.encode(parameters);
    const hasQuery = method === "GET" || method === "DELETE";
    if (hasQuery) url.search = encoded.toString();
    const deadline = AbortSignal.timeout(this.config.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const ca = this.config.caFile ? await Bun.file(this.config.caFile).text() : undefined;
      const response = await ky(url, {
        method,
        headers: { Authorization: `PVEAPIToken=${this.config.tokenId}=${this.config.tokenSecret}` },
        ...(hasQuery ? {} : { body: multipart ?? encoded }),
        retry: 0,
        timeout: false,
        signal: combined,
        redirect: "manual",
        throwHttpErrors: false,
        // Ky supplies timeout/error policy; Bun's transport supplies per-client TLS settings.
        fetch: (input, options) => fetch(input, {
          ...options,
          tls: { rejectUnauthorized: this.config.verifyTls, ...(ca ? { ca } : {}) },
        }),
      });
      if (!response.ok) {
        let body = "";
        try {
          body = await this.readText(response, MAX_ERROR_BODY_BYTES);
        } catch (error) {
          if (error instanceof ProxmoxError) body = "[response body omitted]";
          else throw error;
        }
        throw new ProxmoxError(
          `Proxmox HTTP ${response.status}: ${this.redact(body)}`,
          response.status,
        );
      }
      return response;
    } catch (error) {
      if (error instanceof ProxmoxError) throw error;
      if (error instanceof Error) {
        throw new ProxmoxError(`Proxmox connection failed: ${this.redact(error.message)}`);
      }
      throw error;
    }
  }

  async json(response: Response): Promise<unknown> {
    let value: unknown;
    try {
      value = JSON.parse(await this.readText(response, MAX_API_BODY_BYTES));
    } catch (error) {
      if (error instanceof ProxmoxError) throw error;
      throw new ProxmoxError("Proxmox returned an invalid JSON API envelope");
    }
    const parsed = z.record(z.string(), z.unknown()).safeParse(value);
    if (!parsed.success || !Object.hasOwn(parsed.data, "data")) {
      throw new ProxmoxError("Proxmox returned an invalid JSON API envelope");
    }
    return parsed.data;
  }

  async request(
    method: Method,
    path: string,
    parameters: Parameters = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.json(await this.response(method, path, parameters, signal));
  }
}
