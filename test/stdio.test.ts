import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("initializes and calls Proxmox through the actual stdio process", async () => {
  // Given
  const fixture = Bun.serve({
    port: 0,
    fetch(request) {
      if (request.headers.get("authorization") !== "PVEAPIToken=agent@pve!mcp=stdio-fixture") {
        return new Response("Unauthorized", { status: 401 });
      }
      return Response.json({ data: { version: "fixture-9.0", path: new URL(request.url).pathname } });
    },
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL(process.env["MCP_TEST_ENTRY"] ?? "../src/index.ts", import.meta.url))],
    env: {
      PATH: process.env["PATH"] ?? "",
      PROXMOX_URL: fixture.url.origin,
      PROXMOX_TOKEN_ID: "agent@pve!mcp",
      PROXMOX_TOKEN_SECRET: "stdio-fixture",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    // When
    const result = await client.callTool({ name: "proxmox_get", arguments: { path: "/version" } });
    // Then
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ data: { version: "fixture-9.0", path: "/api2/json/version" } });
  } finally {
    await client.close();
    await transport.close();
    fixture.stop(true);
  }
}, 10_000);

test("exits without exposing credentials when startup configuration is invalid", async () => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), "proxmox-mcp-dotenv-"));
  await Bun.write(join(directory, ".env"),
    "PROXMOX_URL=https://unused.example:8006\nPROXMOX_TOKEN_ID=fixture@pve!test\nPROXMOX_TOKEN_SECRET=dotenv-fixture\n");
  const process = Bun.spawn([
    Bun.which("bun") ?? "bun",
    "--no-env-file",
    fileURLToPath(new URL("../src/index.ts", import.meta.url)),
  ], {
    cwd: directory,
    env: { PROXMOX_TOKEN_SECRET: "do-not-print-this-secret" },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    // When
    const [code, stdout, stderr] = await Promise.all([
      process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
    ]);
    // Then
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).not.toContain("do-not-print-this-secret");
    expect(stderr).toContain("PROXMOX_URL");
  } finally {
    process.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
