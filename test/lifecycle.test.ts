import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProxmoxClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";

const credentials = { PROXMOX_TOKEN_ID: "agent@pve!test", PROXMOX_TOKEN_SECRET: "lifecycle-fixture" };
let directory: string;
let certificate: string;
let key: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "proxmox-mcp-tls-"));
  certificate = join(directory, "cert.pem");
  key = join(directory, "key.pem");
  const process = Bun.spawn([
    "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
    "-keyout", key, "-out", certificate,
  ], { stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  if (code !== 0) throw new Error(`TLS fixture generation failed: ${stderr}`);
});

afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

test("rejects an untrusted certificate by default", async () => {
  // Given
  const fixture = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    tls: { cert: Bun.file(certificate), key: Bun.file(key) },
    fetch: () => Response.json({ data: "verified" }),
  });
  const client = new ProxmoxClient(loadConfig({ ...credentials, PROXMOX_URL: fixture.url.origin }));
  try {
    // When / Then
    await expect(client.request("GET", "/version")).rejects.toThrow();
  } finally { fixture.stop(true); }
});

test.each(["custom-ca", "explicit-insecure"])("connects to a lab node using %s", async (mode) => {
  // Given
  const fixture = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    tls: { cert: Bun.file(certificate), key: Bun.file(key) },
    fetch: () => Response.json({ data: "verified" }),
  });
  const client = new ProxmoxClient(loadConfig({
    ...credentials, PROXMOX_URL: fixture.url.origin,
    ...(mode === "custom-ca" ? { PROXMOX_CA_FILE: certificate } : { PROXMOX_VERIFY_TLS: "false" }),
  }));
  try {
    // When / Then
    expect(await client.request("GET", "/version")).toEqual({ data: "verified" });
  } finally { fixture.stop(true); }
});

test("cancels an in-flight API request after the fixture receives it", async () => {
  // Given: subscribe before starting the request.
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Response>();
  const fixture = Bun.serve({
    port: 0,
    fetch() { received.resolve(); return release.promise; },
  });
  const controller = new AbortController();
  const client = new ProxmoxClient(loadConfig({ ...credentials, PROXMOX_URL: fixture.url.origin }));
  const outcome = client.request("GET", "/nodes", {}, controller.signal).catch((error: unknown) => error);
  try {
    await received.promise;
    // When
    controller.abort();
    // Then
    expect(await outcome).toBeInstanceOf(Error);
  } finally {
    release.resolve(Response.json({ data: [] }));
    fixture.stop(true);
  }
}, 2_000);

test("enforces the deadline while the response body is still streaming", async () => {
  // Given: time itself is the behavior under test; no sleeps or polling.
  const fixture = Bun.serve({
    port: 0,
    fetch() {
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"data":')); },
      }), { headers: { "Content-Type": "application/json" } });
    },
  });
  const client = new ProxmoxClient(loadConfig({
    ...credentials, PROXMOX_URL: fixture.url.origin, PROXMOX_TIMEOUT_MS: "100",
  }));
  try {
    // When / Then
    await expect(client.request("GET", "/nodes")).rejects.toThrow();
  } finally { fixture.stop(true); }
}, 2_000);
