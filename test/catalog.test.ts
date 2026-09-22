import { describe, expect, test } from "bun:test";
import { ApiCatalog } from "../src/catalog.js";

const metadata = {
  description: 'Read virtual machine configuration, including "]" and escaped "\\".',
  allowtoken: 1,
  parameters: { properties: { vmid: { type: "integer" } }, additionalProperties: 0 },
  returns: { type: "object", properties: { name: { type: "string" } } },
  permissions: { check: ["perm", "/vms/{vmid}", ["VM.Audit"]] },
  protected: 1,
};
const methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE", "CONNECT"];
const tree = [{
  path: "/nodes",
  info: { GET: { description: "List nodes", allowtoken: 1 } },
  children: [{
    path: "/nodes/{node}",
    children: [{
      path: "/nodes/{node}/qemu/{vmid}",
      info: Object.fromEntries(methods.map((method) => [method, { ...metadata, method }])),
    }],
  }],
}, {
  path: "/nodes/special/qemu/100",
  info: { GET: { description: "Literal endpoint", allowtoken: 0 } },
}];

function fixture(body: string | ((request: Request, count: number) => Response | Promise<Response>)) {
  let requests = 0;
  const headers: Headers[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests++;
      headers.push(request.headers);
      return typeof body === "string" ? new Response(body) : body(request, requests);
    },
  });
  return {
    url: server.url.href,
    headers,
    get requests() { return requests; },
    [Symbol.dispose]() { server.stop(true); },
  };
}

describe("API catalog", () => {
  test.each(["const apiSchema", "var pveapi", "json"])("traverses nested nodes and all methods from %s", async (format) => {
    // Given
    const json = JSON.stringify(tree);
    using server = fixture(format === "json" ? json : `${format} = ${json};\nthrow new Error("UI must not execute");`);
    const catalog = new ApiCatalog(server.url);
    expect(server.requests).toBe(0);
    // When
    const result = await catalog.search("", undefined, 0, 100);
    // Then
    expect(result).toMatchObject({ source: server.url, total: 11, offset: 0 });
    for (const method of methods) {
      expect(result).toHaveProperty("endpoints", expect.arrayContaining([
        expect.objectContaining({ path: "/nodes/{node}/qemu/{vmid}", method, allowtoken: 1 }),
      ]));
    }
    expect(server.headers[0]?.has("authorization")).toBe(false);
    expect(server.headers[0]?.has("cookie")).toBe(false);
  });

  test("searches case-insensitive AND words and filters methods before pagination", async () => {
    // Given
    using server = fixture(JSON.stringify(tree));
    const catalog = new ApiCatalog(server.url);
    // When / Then
    expect(await catalog.search("QEMU virtual", undefined, 2, 2)).toMatchObject({
      total: 9, offset: 2,
      endpoints: [{ method: "PUT" }, { method: "DELETE" }],
    });
    expect(await catalog.search("get CONFIGURATION", "get", 0, 10)).toMatchObject({ total: 1 });
    expect(await catalog.search("virtual missing", undefined, 0, 10)).toMatchObject({ total: 0, endpoints: [] });
    expect(await catalog.search("", undefined, 99, 10)).toMatchObject({ total: 11, offset: 99, endpoints: [] });
    expect(await catalog.search("", undefined, 0, 0)).toMatchObject({ total: 11, endpoints: [] });
  });

  test("retains full metadata for template and concrete descriptions", async () => {
    // Given
    using server = fixture(JSON.stringify(tree));
    const catalog = new ApiCatalog(server.url);
    // When / Then
    for (const path of ["/nodes/{node}/qemu/{vmid}", "/nodes/pve-1/qemu/100"]) {
      expect(await catalog.describe(path, "get")).toEqual({
        ...metadata, path: "/nodes/{node}/qemu/{vmid}", method: "GET",
      });
    }
    expect(await catalog.describe("/nodes/special/qemu/100", "GET")).toMatchObject({
      path: "/nodes/special/qemu/100", allowtoken: 0,
    });
    await expect(catalog.describe("/nodes/pve/qemu/100/extra", "GET")).rejects.toThrow();
    await expect(catalog.describe("/nodes//qemu/100", "GET")).rejects.toThrow();
    await expect(catalog.describe("/nodes", "POST")).rejects.toThrow();
  });

  test("treats regular expression characters in literal paths literally", async () => {
    // Given
    using server = fixture(JSON.stringify([{ path: "/items/a.b/{id}", info: { GET: {} } }]));
    const catalog = new ApiCatalog(server.url);
    // When / Then
    expect(await catalog.describe("/items/a.b/7", "GET")).toMatchObject({ path: "/items/a.b/{id}" });
    await expect(catalog.describe("/items/axb/7", "GET")).rejects.toThrow();
  });

  test.each([
    'const apiSchema = [',
    'const apiSchema = [{"path":42}];',
    'const apiSchema = [{"path":"/x","info":{"GET":{"description":42}}}];',
    'globalThis.__catalogExecuted = true; const apiSchema = [];',
    'const apiSchema = [(()=>{globalThis.__catalogExecuted = true; return {};})()];',
    'const apiSchema = [] + (()=>{globalThis.__catalogExecuted = true; return [];})();',
    '{"path":"/not-an-array"}',
  ])("rejects invalid data without executing downloaded code: %#", async (source) => {
    // Given
    using server = fixture(source);
    const catalog = new ApiCatalog(`${server.url}?token=secret-marker`);
    // When
    let caught: unknown;
    try { await catalog.search("", undefined, 0, 10); } catch (error) { caught = error; }
    // Then
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain("secret-marker");
    expect(String(caught)).not.toContain(source);
    expect(Reflect.has(globalThis, "__catalogExecuted")).toBe(false);
  });

test("caches successful parses across search and describe", async () => {
    // Given
    using server = fixture((_request, count) => count === 1
      ? new Response(JSON.stringify(tree))
      : new Response("unexpected request", { status: 500 }));
    const catalog = new ApiCatalog(server.url);
    // When
    await catalog.search("", undefined, 0, 10);
    await catalog.describe("/nodes", "GET");
    await catalog.search("nodes", "GET", 0, 10);
    // Then
    expect(server.requests).toBe(1);
  });

  test("returns discovery summaries without embedding full parameter schemas", async () => {
    // Given
    using server = fixture(JSON.stringify(tree));
    const catalog = new ApiCatalog(server.url);
    // When
    const result = await catalog.search("virtual", "GET", 0, 20);
    // Then
    expect(result.endpoints).toEqual([{
      path: "/nodes/{node}/qemu/{vmid}",
      method: "GET",
      description: metadata.description,
      allowtoken: 1,
    }]);
  });

  test("omits URL credentials from successful discovery results", async () => {
    // Given
    const receivedTokens: (string | null)[] = [];
    using server = fixture((request) => {
      receivedTokens.push(new URL(request.url).searchParams.get("token"));
      return new Response(JSON.stringify(tree));
    });
    const catalog = new ApiCatalog(`${server.url}?token=private-catalog-token#private-fragment`);
    // When
    const result = await catalog.search("", undefined, 0, 10);
    // Then: authentication still reaches the catalog, but not the MCP result.
    expect(receivedTokens).toEqual(["private-catalog-token"]);
    expect(result.source).toBe(server.url);
    expect(JSON.stringify(result)).not.toContain("private-catalog-token");
    expect(JSON.stringify(result)).not.toContain("private-fragment");
  });

  test.each(["fetch", "parse"])("recovers on the next call after a %s failure without retries", async (failure) => {
    // Given
    using server = fixture((_request, count) => count === 1
      ? new Response("invalid schema secret-marker", { status: failure === "fetch" ? 503 : 200 })
      : new Response(JSON.stringify(tree)));
    const catalog = new ApiCatalog(`${server.url}?token=secret-marker`);
    // When / Then
    await expect(catalog.search("", undefined, 0, 10)).rejects.not.toThrow("secret-marker");
    expect(server.requests).toBe(1);
    expect(await catalog.search("", undefined, 0, 10)).toMatchObject({ total: 11 });
    expect(server.requests).toBe(2);
  });

test("aborts a download and permits the next call to recover", async () => {
    // Given
    const received = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Response>();
    using server = fixture((_request, count) => {
      if (count > 1) return new Response(JSON.stringify(tree));
      received.resolve();
      return release.promise;
    });
    const controller = new AbortController();
    const catalog = new ApiCatalog(server.url);
    // When
    const pending = catalog.search("", undefined, 0, 10, controller.signal);
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await received.promise;
      controller.abort(new Error("secret-marker"));
      const error = await outcome;
      // Then
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("secret-marker");
      expect(await catalog.search("", undefined, 0, 10)).toMatchObject({ total: 11 });
    } finally {
      release.resolve(new Response(JSON.stringify(tree)));
    }
}, 2_000);

test("does not follow a catalog redirect to another origin", async () => {
  // Given
  let redirected = false;
  using privateServer = fixture(() => {
    redirected = true;
    return new Response(JSON.stringify(tree));
  });
  using catalogServer = fixture(() => Response.redirect(privateServer.url, 302));
  const catalog = new ApiCatalog(catalogServer.url);
  // When / Then
  await expect(catalog.search("", undefined, 0, 10)).rejects.toThrow();
  expect(redirected).toBe(false);
});

test("coalesces concurrent first catalog callers into one fetch", async () => {
  // Given
  using server = fixture(JSON.stringify(tree));
  const catalog = new ApiCatalog(server.url);
  // When
  const callers = Array.from({ length: 8 }, () => catalog.search("", undefined, 0, 10));
  // Then
  await expect(Promise.all(callers)).resolves.toHaveLength(8);
  expect(server.requests).toBe(1);
});

test("rejects an oversized catalog before parsing it", async () => {
  // Given
  const oversized = `const apiSchema = ${" ".repeat(8 * 1024 * 1024)}[];`;
  using server = fixture(oversized);
  const catalog = new ApiCatalog(server.url);
  // When / Then
  await expect(catalog.search("", undefined, 0, 10)).rejects.toThrow();
});
});
