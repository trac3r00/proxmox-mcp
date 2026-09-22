import { describe, expect, test } from "bun:test";
import { ApiCatalog } from "../src/catalog.js";
import { ProxmoxClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";

// Reduced JSON projections, not invented release labels. Retrieved 2026-09-22:
// https://pve.proxmox.com/pve-docs-6/api-viewer/apidoc.js (index: 6.4)
// https://pve.proxmox.com/pve-docs/api-viewer/apidoc.js (index: 9.2.12)
// Kept: real assignment, absolute nested paths, selected metadata/return fields.
// Removed: other endpoints and unrelated parameter/return properties.
// Full-source SHA-256 values and the four complete-catalog probes are in
// docs/compatibility.md. No downloaded JavaScript is evaluated.
const historical = String.raw`var pveapi = [
  {
    "path": "/access",
    "children": [{
      "path": "/access/users/{userid}/token/{tokenid}",
      "info": {"PUT": {
        "allowtoken": 1,
        "description": "Update API token for a specific user.",
        "parameters": {"additionalProperties": 0, "properties": {
          "tokenid": {"pattern": "(?^:[A-Za-z][A-Za-z0-9\\.\\-_]+)", "type": "string"},
          "privsep": {"default": 1, "optional": 1, "type": "boolean"}
        }},
        "permissions": {"check": ["or", ["userid-param", "self"],
          ["perm", "/access/users/{userid}", ["User.Modify"]]]},
        "protected": 1,
        "returns": {"type": "object", "properties": {
          "privsep": {"default": 1, "optional": 1, "type": "boolean"}
        }}
      }}
    }]
  },
  {
    "leaf": 1, "path": "/version", "text": "version",
    "info": {"GET": {
      "allowtoken": 1,
      "description": "API version details. The result also includes the global datacenter confguration.",
      "parameters": {"additionalProperties": 0},
      "permissions": {"user": "all"},
      "returns": {"properties": {
        "release": {"type": "string"},
        "repoid": {"type": "string"},
        "version": {"type": "string"}
      }, "type": "object"}
    }}
  }
]
;
// Historical viewer code requires Ext; the catalog must not execute this.
if (!Ext.isDefined(Ext.global.console)) { throw new Error("viewer executed"); }
`;

const current = String.raw`const apiSchema = [
  {
    "path": "/access",
    "children": [{
      "path": "/access/users/{userid}/token/{tokenid}",
      "info": {"PUT": {
        "allowtoken": 1,
        "description": "Update API token for a specific user. NOTE: when 'regenerate' is set, the returned token value needs to be stored as it cannot be retrieved afterwards!",
        "parameters": {"additionalProperties": 0, "properties": {
          "tokenid": {"pattern": "(?^:[A-Za-z][A-Za-z0-9\\.\\-_]+)", "type": "string"},
          "regenerate": {"default": 0, "optional": 1, "type": "boolean"}
        }},
        "permissions": {"check": ["or", ["userid-param", "self"],
          ["userid-group", ["User.Modify"]]]},
        "protected": 1,
        "returns": {"type": "object", "properties": {
          "value": {"optional": 1, "type": "string"}
        }}
      }}
    }]
  },
  {
    "leaf": 1, "path": "/version", "text": "version",
    "info": {"GET": {
      "allowtoken": 1,
      "description": "API version details, including some parts of the global datacenter config.",
      "parameters": {"additionalProperties": 0},
      "permissions": {"user": "all"},
      "returns": {"properties": {
        "console": {"enum": ["applet", "vv", "html5", "xtermjs"], "optional": 1, "type": "string"},
        "release": {"type": "string"},
        "repoid": {"pattern": "[0-9a-fA-F]{8,64}", "type": "string"},
        "version": {"type": "string"}
      }, "type": "object"}
    }}
  }
]
;
let method2cmd = { GET: 'get', POST: 'create', PUT: 'set', DELETE: 'delete' };
throw new Error("viewer code must not execute");
`;

function fixture(body: string | ((request: Request) => Response | Promise<Response>)) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => typeof body === "string" ? new Response(body) : body(request),
  });
  return {
    url: server.url.href,
    [Symbol.dispose]() { server.stop(true); },
  };
}

describe("Proxmox compatibility contracts", () => {
  test.each([historical, current])("discovers real old/new viewer projections without executing their suffix: %#", async (source) => {
    // Given
    using server = fixture(source);
    const catalog = new ApiCatalog(server.url);
    // When
    const result = await catalog.search("access token", "put", 0, 10);
    // Then
    expect(result.total).toBe(1);
    expect(result.endpoints[0]).toMatchObject({
      path: "/access/users/{userid}/token/{tokenid}", method: "PUT", allowtoken: 1,
    });
  });

  test("preserves historical token permission expressions and opaque Perl patterns", async () => {
    // Given
    using server = fixture(historical);
    const catalog = new ApiCatalog(server.url);
    // When
    const endpoint = await catalog.describe("/access/users/mcp@pve/token/agent", "PUT");
    // Then: neither interpret server-side ACLs nor compile Perl syntax as JS.
    expect(endpoint).toMatchObject({
      path: "/access/users/{userid}/token/{tokenid}",
      protected: 1,
      permissions: { check: ["or", ["userid-param", "self"],
        ["perm", "/access/users/{userid}", ["User.Modify"]]] },
    });
    expect(endpoint).toHaveProperty("parameters.properties.tokenid.pattern", "(?^:[A-Za-z][A-Za-z0-9\\.\\-_]+)");
    expect(endpoint).not.toHaveProperty("parameters.properties.regenerate");
  });

  test("preserves current token rotation fields and changed permission expressions", async () => {
    // Given
    using server = fixture(current);
    const catalog = new ApiCatalog(server.url);
    // When
    const endpoint = await catalog.describe("/access/users/mcp@pve/token/agent", "PUT");
    // Then: these fields/ACL expressions differ from the historical projection.
    expect(endpoint).toHaveProperty("parameters.properties.regenerate", {
      default: 0, optional: 1, type: "boolean",
    });
    expect(endpoint).toHaveProperty("returns.properties.value", { optional: 1, type: "string" });
    expect(endpoint).toHaveProperty("permissions.check", [
      "or", ["userid-param", "self"], ["userid-group", ["User.Modify"]],
    ]);
  });

  test("keeps real return-schema additions rather than substituting a fixed release schema", async () => {
    // Given
    using oldServer = fixture(historical);
    using newServer = fixture(current);
    // When
    const oldVersion = await new ApiCatalog(oldServer.url).describe("/version", "GET");
    const newVersion = await new ApiCatalog(newServer.url).describe("/version", "GET");
    // Then
    expect(oldVersion).toHaveProperty("returns.properties.repoid", { type: "string" });
    expect(oldVersion).not.toHaveProperty("returns.properties.console");
    expect(newVersion).toHaveProperty("returns.properties.repoid.pattern", "[0-9a-fA-F]{8,64}");
    expect(newVersion).toHaveProperty("returns.properties.console.enum", ["applet", "vv", "html5", "xtermjs"]);
  });

  test("tolerates unknown JSON metadata without assuming an unreleased API format", async () => {
    // Given: deliberately synthetic extension of a genuine schema, not a release fixture.
    const extension = { flags: [true, null, 7], schema: { nested: "value" } };
    const source = current.replace('"allowtoken": 1,', `"future-metadata": ${JSON.stringify(extension)}, "allowtoken": 1,`);
    using server = fixture(source);
    // When
    const endpoint = await new ApiCatalog(server.url).describe("/access/users/u@pve/token/id", "PUT");
    // Then
    expect(endpoint["future-metadata"]).toEqual(extension);
  });

  test("sends an uncatalogued path without version, repository, or discovery prerequisites", async () => {
    // Given: synthetic future path; this proves routing, not future server support.
    const received: { path: string; auth: string | null; csrf: string | null; body: string }[] = [];
    using server = fixture(async (request) => {
      received.push({
        path: new URL(request.url).pathname,
        auth: request.headers.get("authorization"),
        csrf: request.headers.get("csrfpreventiontoken"),
        body: await request.text(),
      });
      return Response.json({ data: null });
    });
    const client = new ProxmoxClient(loadConfig({
      PROXMOX_URL: server.url,
      PROXMOX_TOKEN_ID: "mcp@pve!agent",
      PROXMOX_TOKEN_SECRET: "offline-fixture-secret",
      PROXMOX_SCHEMA_URL: `${server.url}unavailable-schema`,
    }));
    // When
    const response = await client.response("PUT", "/future-extension/resource", {
      net0: "virtio,bridge=vmbr0,tag=7", enabled: true,
    });
    // Then: only the requested endpoint was contacted; property strings survive encoding.
    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      path: "/api2/json/future-extension/resource",
      auth: "PVEAPIToken=mcp@pve!agent=offline-fixture-secret",
      csrf: null,
    });
    expect(Object.fromEntries(new URLSearchParams(received[0]?.body))).toEqual({
      net0: "virtio,bridge=vmbr0,tag=7", enabled: "1",
    });
  });
});
