import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { open, unlink } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import { ApiCatalog } from "./catalog.js";
import { methodSchema, parametersSchema, ProxmoxClient, ProxmoxError } from "./client.js";
import type { Config } from "./config.js";
import { LocalFilePolicy } from "./file-policy.js";

export function createServer(config: Config): McpServer {
  const server = new McpServer({ name: "proxmox-ve-mcp", version: "0.1.0" }, {
    instructions: "Use proxmox_search_endpoints and proxmox_describe_endpoint to discover parameters, "
      + "permissions and token restrictions, then proxmox_get or proxmox_request with a concrete "
      + "API-relative path. Coverage is not restricted to the catalog. Proxmox property strings "
      + "(net0, scsi0, etc.) must be strings, not nested objects. Writes can be destructive. "
      + "A returned UPID means a task was submitted, not completed; query "
      + "/nodes/{node}/tasks/{upid}/status and /log. API token permissions are enforced by Proxmox.",
  });
  const proxmox = new ProxmoxClient(config);
  const catalog = new ApiCatalog(config.schemaUrl);
  const files = new LocalFilePolicy(config.fileRoots);
  const pathSchema = z.string().min(1).describe("Concrete API path, e.g. /nodes/pve/qemu/100/status/start; no /api2/json prefix");
  const parameters = parametersSchema.default({}).describe("Proxmox parameter names and scalar values. Booleans become 1/0; arrays send repeated keys. Use strings for Proxmox property-string formats.");
  const localFile = z.string().refine(isAbsolute, "Use an absolute path on the MCP server machine");
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;
  const writes = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

  async function run(operation: () => Promise<unknown>): Promise<CallToolResult> {
    try {
      const value = await operation();
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new ProxmoxError("Proxmox operation returned no serializable result");
      const text = proxmox.redact(serialized);
      const structuredContent = z.record(z.string(), z.unknown()).parse(
        text === serialized ? value : JSON.parse(text),
      );
      return { content: [{ type: "text", text }], structuredContent };
    } catch (error) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: proxmox.redact(error instanceof Error ? error.message : "Proxmox operation failed"),
        }],
      };
    }
  }

  server.registerTool("proxmox_get", {
    description: "Read any Proxmox VE JSON API endpoint. Query nodes, VMs, containers, tasks, cluster, storage, network, ACLs, firewall, HA, Ceph and more.",
    inputSchema: { path: pathSchema, parameters },
    annotations: readOnly,
  }, ({ path, parameters }, extra) => run(() => proxmox.request("GET", path, parameters, extra.signal)));

  server.registerTool("proxmox_request", {
    description: "Call ANY Proxmox VE HTTP API endpoint, including create, update, delete, power, migrate, backup, restore and administration. No endpoint allowlist. Token ACLs and token-auth exclusions still apply. A UPID is asynchronous; check its status before claiming success.",
    inputSchema: {
      method: methodSchema, path: pathSchema, parameters,
      response_format: z.enum(["json", "text"]).default("json"),
    },
    annotations: writes,
  }, ({ method, path, parameters, response_format }, extra) => run(async () => {
    const response = await proxmox.response(method, path, parameters, extra.signal);
    return response_format === "text" ? { data: await proxmox.text(response) } : proxmox.json(response);
  }));

  server.registerTool("proxmox_upload", {
    description: "Upload a local ISO, container template, or other file to a Proxmox multipart endpoint. file_path is on the MCP server machine. For storage upload use parameters.content = iso or vztmpl.",
    inputSchema: {
      path: pathSchema, file_path: localFile, parameters,
      file_field: z.string().min(1).default("filename"),
    },
    annotations: writes,
  }, ({ path, file_path, parameters, file_field }, extra) => run(async () => {
    const source = await files.uploadSource(file_path);
    try {
      if (Object.hasOwn(parameters, file_field)) throw new ProxmoxError("File field must not also appear in parameters");
      const form = new FormData();
      for (const [key, value] of Object.entries(parameters)) {
        for (const item of Array.isArray(value) ? value : [value]) {
          form.append(key, typeof item === "boolean" ? (item ? "1" : "0") : String(item));
        }
      }
      form.append(file_field, Bun.file(source.handle.fd), source.filename);
      return proxmox.json(await proxmox.response("POST", path, {}, extra.signal, form));
    } finally {
      await source.handle.close();
    }
  }));

  server.registerTool("proxmox_download", {
    description: "Stream a raw API response to a NEW local file (binary or text). Never overwrites an existing file. destination is an absolute path on the MCP server machine; its parent must exist. Supports any HTTP API method.",
    inputSchema: {
      path: pathSchema, destination: localFile, parameters,
      method: methodSchema.default("GET"),
    },
    annotations: writes,
  }, ({ path, destination, parameters, method }, extra) => run(async () => {
    const safeDestination = await files.downloadPath(destination);
    const file = await open(safeDestination, "wx", 0o600);
    let complete = false;
    try {
      const response = await proxmox.response(method, path, parameters, extra.signal);
      let bytes = 0;
      if (response.body) {
        for await (const chunk of response.body) {
          extra.signal.throwIfAborted();
          await file.writeFile(chunk);
          bytes += chunk.byteLength;
        }
      }
      complete = true;
      return { destination, bytes, contentType: response.headers.get("content-type") };
    } finally {
      await file.close();
      if (!complete) await unlink(safeDestination);
    }
  }));

  server.registerTool("proxmox_search_endpoints", {
    description: "Search the complete official API catalog by path and description. Returns paginated methods and token-auth restrictions. Catalog loads lazily; use PROXMOX_SCHEMA_URL for version-matched docs. Catalog availability does not limit API calls.",
    inputSchema: {
      query: z.string().default(""),
      method: methodSchema.optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(20),
    },
    annotations: readOnly,
  }, ({ query, method, offset, limit }, extra) => run(() => catalog.search(query, method, offset, limit, extra.signal)));

  server.registerTool("proxmox_describe_endpoint", {
    description: "Get the full parameter schema, return schema, permissions and allowtoken metadata for an endpoint. Accepts concrete or template paths. Read this before constructing unfamiliar API calls.",
    inputSchema: { path: pathSchema, method: methodSchema },
    annotations: readOnly,
  }, ({ path, method }, extra) => run(() => catalog.describe(path, method, extra.signal)));

  return server;
}
