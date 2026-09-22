import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { ProxmoxClient } from "../src/client.js";

const credentials = {
  PROXMOX_TOKEN_ID: "mcp@pve!agent",
  PROXMOX_TOKEN_SECRET: "test-secret-not-a-real-token",
};

describe("configuration", () => {
  test("requires credentials when no configuration is supplied", () => {
    // Given / When / Then
    expect(() => loadConfig({})).toThrow();
  });

  test("normalizes the API URL when the user includes its suffix", () => {
    // Given / When
    const config = loadConfig({ ...credentials, PROXMOX_URL: "https://pve.example:8006/api2/json/" });
    // Then
    expect(config.baseUrl).toBe("https://pve.example:8006");
    expect(config.verifyTls).toBe(true);
  });

  test.each(["ftp://host", "https://user:pass@host", "https://host/prefix", "https://host?secret=yes"])(
    "rejects an invalid base URL: %s", (url) => {
      // Given / When / Then
      expect(() => loadConfig({ ...credentials, PROXMOX_URL: url })).toThrow();
    },
  );

  test("rejects cleartext HTTP for a non-loopback Proxmox host", () => {
    // Given / When / Then
    expect(() => loadConfig({
      ...credentials,
      PROXMOX_URL: "http://pve.example:8006",
    })).toThrow();
  });

  test("allows explicitly acknowledged cleartext HTTP for a non-loopback host", () => {
    // Given / When
    const config = loadConfig({
      ...credentials,
      PROXMOX_URL: "http://pve.example:8006",
      PROXMOX_ALLOW_INSECURE_HTTP: "true",
    });
    // Then
    expect(config.baseUrl).toBe("http://pve.example:8006");
  });
});

describe("Proxmox HTTP adapter", () => {
  test.each(["GET", "POST", "PUT", "DELETE"] as const)(
    "sends authenticated parameters with %s", async (method) => {
      // Given
      const fixture = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          const params = ["GET", "DELETE"].includes(request.method)
            ? url.searchParams : new URLSearchParams(await request.text());
          return Response.json({ data: {
            method: request.method,
            path: url.pathname,
            auth: request.headers.get("authorization"),
            csrf: request.headers.get("csrfpreventiontoken"),
            values: Object.fromEntries(params),
            tags: params.getAll("tag"),
          } });
        },
      });
      const client = new ProxmoxClient(loadConfig({ ...credentials, PROXMOX_URL: fixture.url.origin }));
      try {
        // When
        const result = await client.request(method, "/nodes/pve/qemu/100/config", {
          memory: 2048, onboot: true, description: "a & b=✓", tag: ["one", "two"],
        });
        // Then
        expect(result).toEqual({ data: {
          method, path: "/api2/json/nodes/pve/qemu/100/config",
          auth: "PVEAPIToken=mcp@pve!agent=test-secret-not-a-real-token",
          csrf: null,
          values: { memory: "2048", onboot: "1", description: "a & b=✓", tag: "two" },
          tags: ["one", "two"],
        } });
      } finally {
        fixture.stop(true);
      }
    },
  );

  test.each([
    "//other-host/nodes", "https://other-host/nodes", "/../access", "/%2e%2e/access",
    "/nodes/%252e%252e/access", "/nodes?x=1", "/nodes#fragment", "/nodes\\other",
  ])("rejects paths that escape or change the API target: %s", async (path) => {
    // Given
    const client = new ProxmoxClient(loadConfig({ ...credentials, PROXMOX_URL: "https://pve.example:8006" }));
    // When / Then
    await expect(client.request("GET", path)).rejects.toThrow();
  });

  test("returns a redacted error without retrying when Proxmox denies access", async () => {
    // Given
    let requests = 0;
    const fixture = Bun.serve({
      port: 0,
      fetch() {
        requests++;
        return Response.json({ errors: { token: credentials.PROXMOX_TOKEN_SECRET } }, { status: 403 });
      },
    });
    const client = new ProxmoxClient(loadConfig({ ...credentials, PROXMOX_URL: fixture.url.origin }));
    try {
      // When
      const error = await client.request("POST", "/nodes/pve/qemu/100/status/start").catch((e: unknown) => e);
      // Then
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("403");
      expect(String(error)).not.toContain(credentials.PROXMOX_TOKEN_SECRET);
      expect(requests).toBe(1);
    } finally {
      fixture.stop(true);
    }
  });

  test("does not forward credentials when the API responds with a redirect", async () => {
    // Given
    let redirected = false;
    const other = Bun.serve({ port: 0, fetch() { redirected = true; return Response.json({ data: null }); } });
    const fixture = Bun.serve({ port: 0, fetch() { return Response.redirect(other.url, 302); } });
    const client = new ProxmoxClient(loadConfig({ ...credentials, PROXMOX_URL: fixture.url.origin }));
    try {
      // When / Then
      await expect(client.request("GET", "/version")).rejects.toThrow();
      expect(redirected).toBe(false);
    } finally {
      fixture.stop(true);
      other.stop(true);
    }
  });

  test("rejects an API JSON body that exceeds the MCP-safe limit", async () => {
    // Given
    const fixture = Bun.serve({
      port: 0,
      fetch() { return Response.json({ data: "x".repeat(513 * 1024) }); },
    });
    const client = new ProxmoxClient(loadConfig({ ...credentials, PROXMOX_URL: fixture.url.origin }));
    try {
      // When / Then
      await expect(client.request("GET", "/nodes")).rejects.toThrow("response body exceeds");
    } finally {
      fixture.stop(true);
    }
  });
});
