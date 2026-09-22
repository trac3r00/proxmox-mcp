import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

let client: Client;
let close: () => Promise<void>;
let directory: string;
let outsideDirectory: string;
let calls: { method: string; path: string; body: string }[];

beforeEach(async () => {
  calls = [];
  directory = await mkdtemp(join(tmpdir(), "proxmox-mcp-test-"));
  outsideDirectory = await mkdtemp(join(tmpdir(), "proxmox-mcp-outside-"));
  const fixture = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/upload")) {
        const form = await request.formData();
        const file = form.get("filename");
        return Response.json({ data: {
          content: form.get("content"),
          filename: file instanceof File ? file.name : null,
          bytes: file instanceof File ? await file.text() : null,
        } });
      }
      calls.push({ method: request.method, path, body: await request.text() });
      if (path.endsWith("/download")) return new Response(new Uint8Array([0, 1, 2, 254, 255]));
      if (path.endsWith("/denied")) return Response.json({ errors: { permission: "denied" } }, { status: 403 });
      if (path.endsWith("/plain")) return new Response("console configuration");
      return Response.json({ data: "UPID:pve:0001:0002:0003:qmstart:100:agent@pve:", total: 1 });
    },
  });
  const server = createServer(loadConfig({
    PROXMOX_URL: fixture.url.origin,
    PROXMOX_TOKEN_ID: "agent@pve!mcp",
    PROXMOX_TOKEN_SECRET: "fixture-secret",
    PROXMOX_FILE_ROOTS: directory,
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "integration-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  close = async () => {
    await client.close();
    await server.close();
    fixture.stop(true);
    await rm(directory, { recursive: true, force: true });
    await rm(outsideDirectory, { recursive: true, force: true });
  };
});

afterEach(async () => { await close(); });

test("advertises full API and transfer tools after MCP initialization", async () => {
  // Given / When
  const result = await client.listTools();
  // Then
  expect(result.tools.map((tool) => tool.name).sort()).toEqual([
    "proxmox_describe_endpoint", "proxmox_download", "proxmox_get",
    "proxmox_request", "proxmox_search_endpoints", "proxmox_upload",
  ]);
  expect(result.tools.find((tool) => tool.name === "proxmox_request")?.annotations?.destructiveHint).toBe(true);
});

test("executes a new arbitrary endpoint without requiring catalog membership", async () => {
  // Given / When
  const result = await client.callTool({ name: "proxmox_request", arguments: {
    method: "POST", path: "/future/feature", parameters: { enabled: true },
  } });
  // Then
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual({
    data: "UPID:pve:0001:0002:0003:qmstart:100:agent@pve:", total: 1,
  });
  expect(calls).toEqual([{ method: "POST", path: "/api2/json/future/feature", body: "enabled=1" }]);
});

test("surfaces an upstream denial as an MCP tool error", async () => {
  // Given / When
  const result = await client.callTool({ name: "proxmox_get", arguments: { path: "/denied" } });
  // Then
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("403");
});

test("rejects object parameters instead of accidentally stringifying them", async () => {
  // Given / When
  const result = await client.callTool({ name: "proxmox_request", arguments: {
    method: "PUT", path: "/nodes/pve/qemu/100/config", parameters: { net0: { bridge: "vmbr0" } },
  } });
  // Then
  expect(result.isError).toBe(true);
  expect(calls).toHaveLength(0);
});

test("uploads binary files and form fields through multipart encoding", async () => {
  // Given
  const source = join(directory, "sample.iso");
  await Bun.write(source, "iso fixture");
  // When
  const result = await client.callTool({ name: "proxmox_upload", arguments: {
    path: "/nodes/pve/storage/local/upload", file_path: source, parameters: { content: "iso" },
  } });
  // Then
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual({ data: { content: "iso", filename: "sample.iso", bytes: "iso fixture" } });
});

test("downloads binary responses to a new local file", async () => {
  // Given
  const destination = join(directory, "result.bin");
  // When
  const result = await client.callTool({ name: "proxmox_download", arguments: {
    path: "/download", destination,
  } });
  // Then
  expect(result.isError).not.toBe(true);
  expect(new Uint8Array(await Bun.file(destination).arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 254, 255]));
  expect(result.structuredContent).toMatchObject({ destination, bytes: 5 });
});

test("preserves an existing file when a download destination already exists", async () => {
  // Given
  const destination = join(directory, "keep.txt");
  await Bun.write(destination, "original");
  // When
  const result = await client.callTool({ name: "proxmox_download", arguments: { path: "/download", destination } });
  // Then
  expect(result.isError).toBe(true);
  expect(await Bun.file(destination).text()).toBe("original");
});

test("returns non-JSON endpoints when text response format is selected", async () => {
  // Given / When
  const result = await client.callTool({ name: "proxmox_request", arguments: {
    method: "GET", path: "/plain", response_format: "text",
  } });
  // Then
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual({ data: "console configuration" });
});

test("removes a new download file when the upstream request fails", async () => {
  // Given
  const destination = join(directory, "failed.bin");
  // When
  const result = await client.callTool({ name: "proxmox_download", arguments: { path: "/denied", destination } });
  // Then
  expect(result.isError).toBe(true);
  expect(await Bun.file(destination).exists()).toBe(false);
});

test("rejects a missing upload source before making an API request", async () => {
  // Given / When
  const result = await client.callTool({ name: "proxmox_upload", arguments: {
    path: "/upload", file_path: join(directory, "missing.iso"), parameters: { content: "iso" },
  } });
  // Then
  expect(result.isError).toBe(true);
  expect(calls).toHaveLength(0);
});

test("rejects uploading a readable file outside configured roots", async () => {
  // Given
  const source = join(outsideDirectory, "private-key");
  await Bun.write(source, "sensitive fixture");
  // When
  const result = await client.callTool({ name: "proxmox_upload", arguments: {
    path: "/upload", file_path: source, parameters: { content: "iso" },
  } });
  // Then
  expect(result.isError).toBe(true);
  expect(calls).toHaveLength(0);
});

test("rejects uploading through a symlink that escapes configured roots", async () => {
  // Given
  const outside = join(outsideDirectory, "private-key");
  const source = join(directory, "linked-key");
  await Bun.write(outside, "sensitive fixture");
  await symlink(outside, source);
  // When
  const result = await client.callTool({ name: "proxmox_upload", arguments: {
    path: "/upload", file_path: source, parameters: { content: "iso" },
  } });
  // Then
  expect(result.isError).toBe(true);
  expect(calls).toHaveLength(0);
});

test("uploads the opened file when its pathname is replaced at the native file boundary", async () => {
  // Given
  const source = join(directory, "stable.iso");
  const outside = join(outsideDirectory, "outside-secret");
  await Bun.write(source, "allowed fixture");
  await Bun.write(outside, "outside fixture");
  const originalFile = Bun.file;
  let attemptedPathOpen = false;
  (Bun as unknown as { file: typeof Bun.file }).file = ((input: string | number | URL, options) => {
    if (input === source) {
      attemptedPathOpen = true;
      unlinkSync(source);
      symlinkSync(outside, source);
    }
    return originalFile(input as string | URL, options);
  }) as typeof Bun.file;
  try {
    // When
    const result = await client.callTool({ name: "proxmox_upload", arguments: {
      path: "/upload", file_path: source, parameters: { content: "iso" },
    } });
    // Then
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ data: { bytes: "allowed fixture" } });
    expect(attemptedPathOpen).toBe(false);
  } finally {
    (Bun as unknown as { file: typeof Bun.file }).file = originalFile;
  }
});

test("rejects uploads from a shared descendant directory", async () => {
  // Given
  const shared = join(directory, "shared");
  const source = join(shared, "image.iso");
  await mkdir(shared);
  await Bun.write(source, "fixture");
  await chmod(shared, 0o777);
  // When
  const result = await client.callTool({ name: "proxmox_upload", arguments: {
    path: "/upload", file_path: source, parameters: { content: "iso" },
  } });
  // Then
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("parent directories");
  expect(calls).toHaveLength(0);
});

test("rejects downloading outside configured roots", async () => {
  // Given
  const destination = join(outsideDirectory, "created-by-model");
  // When
  const result = await client.callTool({ name: "proxmox_download", arguments: {
    path: "/download", destination,
  } });
  // Then
  expect(result.isError).toBe(true);
  expect(await Bun.file(destination).exists()).toBe(false);
});

test("rejects downloading through a directory symlink that escapes configured roots", async () => {
  // Given
  const linkedDirectory = join(directory, "linked-directory");
  const outsideDestination = join(outsideDirectory, "created-by-model");
  await symlink(outsideDirectory, linkedDirectory);
  // When
  const result = await client.callTool({ name: "proxmox_download", arguments: {
    path: "/download", destination: join(linkedDirectory, "created-by-model"),
  } });
  // Then
  expect(result.isError).toBe(true);
  expect(await Bun.file(outsideDestination).exists()).toBe(false);
});

test("disables file transfers when no transfer root is configured", async () => {
  // Given
  const isolated = createServer(loadConfig({
    PROXMOX_URL: "http://127.0.0.1:1",
    PROXMOX_TOKEN_ID: "agent@pve!isolated",
    PROXMOX_TOKEN_SECRET: "fixture-secret",
  }));
  const [isolatedClientTransport, isolatedServerTransport] = InMemoryTransport.createLinkedPair();
  const isolatedClient = new Client({ name: "isolated-test", version: "1.0.0" });
  await isolated.connect(isolatedServerTransport);
  await isolatedClient.connect(isolatedClientTransport);
  try {
    // When
    const result = await isolatedClient.callTool({ name: "proxmox_upload", arguments: {
      path: "/upload", file_path: join(directory, "sample.iso"), parameters: { content: "iso" },
    } });
    // Then
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("PROXMOX_FILE_ROOTS");
  } finally {
    await isolatedClient.close();
    await isolated.close();
  }
});

test("rejects transfer roots writable by another local user", async () => {
  // Given
  const sharedRoot = await mkdtemp(join(tmpdir(), "proxmox-mcp-shared-"));
  await chmod(sharedRoot, 0o777);
  const shared = createServer(loadConfig({
    PROXMOX_URL: "http://127.0.0.1:1",
    PROXMOX_TOKEN_ID: "agent@pve!shared",
    PROXMOX_TOKEN_SECRET: "fixture-secret",
    PROXMOX_FILE_ROOTS: sharedRoot,
  }));
  const [sharedClientTransport, sharedServerTransport] = InMemoryTransport.createLinkedPair();
  const sharedClient = new Client({ name: "shared-root-test", version: "1.0.0" });
  await shared.connect(sharedServerTransport);
  await sharedClient.connect(sharedClientTransport);
  try {
    // When
    const result = await sharedClient.callTool({ name: "proxmox_download", arguments: {
      path: "/download", destination: join(sharedRoot, "result.bin"),
    } });
    // Then
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("not be group or world writable");
  } finally {
    await sharedClient.close();
    await shared.close();
    await rm(sharedRoot, { recursive: true, force: true });
  }
});

test("returns a bounded MCP error for an oversized JSON response", async () => {
  // Given
  const oversizedServer = Bun.serve({
    port: 0,
    fetch() { return Response.json({ data: "x".repeat(513 * 1024) }); },
  });
  const oversized = createServer(loadConfig({
    PROXMOX_URL: oversizedServer.url.origin,
    PROXMOX_TOKEN_ID: "agent@pve!oversized",
    PROXMOX_TOKEN_SECRET: "fixture-secret",
  }));
  const [oversizedClientTransport, oversizedServerTransport] = InMemoryTransport.createLinkedPair();
  const oversizedClient = new Client({ name: "oversized-test", version: "1.0.0" });
  await oversized.connect(oversizedServerTransport);
  await oversizedClient.connect(oversizedClientTransport);
  try {
    // When
    const result = await oversizedClient.callTool({ name: "proxmox_get", arguments: { path: "/nodes" } });
    // Then
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("response body exceeds");
  } finally {
    await oversizedClient.close();
    await oversized.close();
    oversizedServer.stop(true);
  }
});
