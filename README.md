# Proxmox VE MCP

[![CI](https://github.com/trac3r00/proxmox-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/trac3r00/proxmox-mcp/actions/workflows/ci.yml)

Secure, API-token authenticated MCP access to the Proxmox VE HTTP API. See
[CONTRIBUTING.md](CONTRIBUTING.md) for local checks and
[SECURITY.md](SECURITY.md) for private vulnerability reporting.

An MCP server that connects to Proxmox VE using an API token. It exposes **every HTTP API path**, not a hardcoded subset of VM operations, and provides searchable API documentation, multipart uploads, and streamed downloads.

VMs, LXC, nodes, clusters, storage, backups, snapshots, migration, replication, networking, SDN, firewall, Ceph, HA, pools, users, ACLs, metrics, and tasks all use the same API tools. New endpoints work without a server update.

## Install

Requires [Bun](https://bun.sh/) 1.3 or newer.

```sh
cd /absolute/path/to/proxmox-mcp
bun install --frozen-lockfile
bun run build
```

This project uses MCP **stdio**: your MCP client starts a local process which connects over HTTPS to your Proxmox host. It does not expose an unauthenticated MCP HTTP listener. File-transfer paths refer to the machine running this process, not the Proxmox node.

## Create a Proxmox API token

1. In the Proxmox UI, create or select a user under **Datacenter > Permissions > Users**.
2. Under **Datacenter > Permissions > API Tokens**, add a token for that user.
3. Save its token ID (`mcp@pve!assistant`) and the secret shown once at creation.
4. Grant the user the required ACL role and path. With **Privilege Separation** enabled, grant the token permissions too: effective access is the intersection of the user's and token's ACLs.

For broad administration, assign the `Administrator` role at `/` with propagation to both the user and the privilege-separated token. To limit access, assign narrower roles and paths instead. A token cannot exceed its owner's privileges.

**Coverage is not permission bypass.** Proxmox explicitly disallows API tokens on some endpoints (`allowtoken: 0`), and some operations require a particular user, such as `root@pam`. This server exposes those endpoints but returns Proxmox's rejection when token authentication is insufficient. A token alone cannot provide literally every Proxmox function. It does not add password/ticket login, SSH access, or an interactive VNC/SPICE/terminal WebSocket client. HTTP console/ticket endpoints remain callable where Proxmox permits them.

## Connect your MCP client

Add this to your client's MCP configuration, replacing the paths and credentials. Use the absolute Bun path returned by `which bun` if the client does not inherit your shell's PATH.

```json
{
  "mcpServers": {
    "proxmox": {
      "command": "/absolute/path/to/bun",
      "args": ["/absolute/path/to/proxmox-mcp/dist/index.js"],
      "env": {
        "PROXMOX_URL": "https://pve.example.com:8006",
        "PROXMOX_TOKEN_ID": "mcp@pve!assistant",
        "PROXMOX_TOKEN_SECRET": "YOUR_TOKEN_SECRET",
        "PROXMOX_VERIFY_TLS": "true"
      }
    }
  }
}
```

Restart/reconnect the MCP client. Ask it to call `proxmox_get` with `{"path":"/version"}`, then `{"path":"/nodes"}`. These calls verify the connection and token permissions.

For development, copy `.env.example` to `.env`, fill it in, and run `bun start` from the project directory. Bun loads `.env` automatically. The process waits for MCP input; it is not an interactive command prompt. Keep secrets in the client's environment/secret store or a private environment file, not in tool arguments.

### OmO installation on this machine

This installation is an explicit native OmO skill at
`~/.agents/skills/proxmox-ve/`. Invoke `/skill:proxmox-ve` (or
`$proxmox-ve`) in a fresh session before calling a Proxmox tool. Its MCP
sidecar uses `--env-file=/Users/cminseo/proxmox-mcp/.env`, so credentials stay
in the ignored, mode-`0600` project file rather than OmO's global MCP
configuration. The global configuration deliberately has no `proxmox` entry:
that avoids a system-config collision and keeps tool activation skill-owned.

After explicit activation, `/mcp status` should report `proxmox` connected
with six tools. OmO maps them to:

- `mcp_proxmox_proxmox_get`
- `mcp_proxmox_proxmox_request`
- `mcp_proxmox_proxmox_upload`
- `mcp_proxmox_proxmox_download`
- `mcp_proxmox_proxmox_search_endpoints`
- `mcp_proxmox_proxmox_describe_endpoint`

The read-only OmO integration check is:

```sh
bun ~/.omo/evidence/proxmox-omo-integration-20260922.mjs --live
```

It calls only three read-only endpoints: `/version`, `/nodes`, and
`/access/permissions`. Without `--live`, it loads the skill sidecar and
exercises them against a local fixture. The deployed check uses
`/access/permissions` to confirm the token's effective ACLs; it makes no
changes. The installed host can still connect a skill-declared server while
collecting its catalog, and tool search can activate tools, so the skill
guarantees explicit discovery guidance rather than a hard process or prompt
isolation boundary.

### Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PROXMOX_URL` | Required | Host origin, normally `https://host:8006`; `/api2/json` suffix is accepted |
| `PROXMOX_TOKEN_ID` | Required | Full `user@realm!token-name` |
| `PROXMOX_TOKEN_SECRET` | Required | Token secret, not the full Authorization header |
| `PROXMOX_VERIFY_TLS` | `true` | Certificate verification; accepts exactly `true` or `false` |
| `PROXMOX_ALLOW_INSECURE_HTTP` | `false` | Required as `true` before a non-loopback `http://` URL is accepted |
| `PROXMOX_CA_FILE` | Unset | Absolute PEM CA path for a private Proxmox CA |
| `PROXMOX_TIMEOUT_MS` | `120000` | Deadline including response-body transfers; raise for large uploads/downloads |
| `PROXMOX_FILE_ROOTS` | Unset (transfers disabled) | Platform-delimited absolute directories allowed for upload/download |
| `PROXMOX_SCHEMA_URL` | Official current API viewer | URL of an API viewer `apidoc.js` or its JSON tree, for endpoint discovery |

Prefer trusting your cluster's CA using `PROXMOX_CA_FILE`. For a self-signed lab server you can explicitly set `PROXMOX_VERIFY_TLS=false`; this affects only this connection, not process-wide TLS. Use HTTPS for remote hosts.

Discovery lazily downloads the [official API viewer schema](https://pve.proxmox.com/pve-docs/api-viewer/apidoc.js), extracts JSON **without executing JavaScript**, rejects redirects, limits the source to 8 MiB, and caches one in-flight load plus the parsed catalog until restart. The default documents the current published version, which may differ from your cluster. Point `PROXMOX_SCHEMA_URL` at version-matched documentation when needed. No Proxmox credentials are sent to the catalog host. Private CA settings apply to API traffic, not the public catalog download.

If documentation is unavailable, API calls still work. Consult your cluster's API viewer and supply its concrete paths and parameters directly.

## Tools

| Tool | Use |
| --- | --- |
| `proxmox_get` | Read any JSON endpoint with query parameters |
| `proxmox_request` | GET, POST, PUT, or DELETE to any endpoint; optional text response |
| `proxmox_upload` | POST multipart file plus scalar form fields |
| `proxmox_download` | Stream any raw HTTP API response into a new local file |
| `proxmox_search_endpoints` | Search by path/description with method filter and pagination |
| `proxmox_describe_endpoint` | Full parameter, return, permission, and token-support metadata |

Paths are relative to `/api2/json`, start with `/`, and cannot contain a query or fragment. Put parameters in `parameters`. Replace template segments with real values. Percent-encode special characters inside identifiers, such as `/` within a volume ID. Do not double-encode.

Booleans become `1` or `0`. GET and DELETE parameters use the query string; POST and PUT use `application/x-www-form-urlencoded`. Arrays produce repeated keys; when Proxmox expects a comma-separated list, supply a string. Proxmox property strings must also be strings, for example `net0: "virtio,bridge=vmbr0"` rather than a nested JSON object. Null and object parameter values are rejected.

JSON responses retain the Proxmox envelope (`data`, `total`, etc.) in both MCP text and structured content. API failures return `isError: true` with HTTP status and details. The configured token ID and secret are redacted from MCP results and errors. The server never automatically retries API operations, and never follows API redirects.

JSON and text API responses are capped at 512 KiB before MCP serialization; use
`proxmox_download` for larger raw artifacts. Upload and download are disabled
until `PROXMOX_FILE_ROOTS` names dedicated directories; canonical paths and
symlinks outside those roots are rejected, and group- or world-writable roots
or upload-parent directories are refused. Uploads are read through a pinned
file descriptor after validation, so later pathname replacement cannot switch
the uploaded file. Write tools can perform destructive
administration if the token allows it; they do not add a confirmation gate
beyond the MCP client's own tool approval controls. Download files use
exclusive creation (no overwrites), mode `0600`, and partial files are removed
on failure.

### Find and call an endpoint

```json
{
  "name": "proxmox_search_endpoints",
  "arguments": { "query": "qemu snapshot", "method": "POST", "limit": 10 }
}
```

```json
{
  "name": "proxmox_describe_endpoint",
  "arguments": { "path": "/nodes/{node}/qemu/{vmid}/snapshot", "method": "POST" }
}
```

```json
{
  "name": "proxmox_request",
  "arguments": {
    "method": "POST",
    "path": "/nodes/pve/qemu/100/snapshot",
    "parameters": { "snapname": "before-upgrade", "description": "Before upgrade" }
  }
}
```

### Start a VM and check its task

```json
{
  "name": "proxmox_request",
  "arguments": { "method": "POST", "path": "/nodes/pve/qemu/100/status/start" }
}
```

A returned `data: "UPID:..."` means the operation was **submitted**, not that it succeeded. Use the actual returned UPID:

```json
{
  "name": "proxmox_get",
  "arguments": { "path": "/nodes/pve/tasks/UPID_FROM_THE_RESPONSE/status" }
}
```

Completion requires `status: "stopped"` and `exitstatus: "OK"`. Inspect `/nodes/pve/tasks/UPID_FROM_THE_RESPONSE/log` for failures. Task listing, cancellation, and log pagination are also available through ordinary API calls.

### Upload an ISO

```json
{
  "name": "proxmox_upload",
  "arguments": {
    "path": "/nodes/pve/storage/local/upload",
    "file_path": "/absolute/path/inside/PROXMOX_FILE_ROOTS/debian.iso",
    "parameters": { "content": "iso" }
  }
}
```

For large images, Proxmox's `/nodes/{node}/storage/{storage}/download-url` API may be preferable: call it with `proxmox_request` to have the node download the image directly.

### Download a raw response

```json
{
  "name": "proxmox_download",
  "arguments": {
    "path": "/nodes/pve/rrd",
    "parameters": { "ds": "cpu", "timeframe": "hour" },
    "destination": "/absolute/path/inside/PROXMOX_FILE_ROOTS/new-chart.png"
  }
}
```

The destination's parent directory must already exist. Use `response_format: "text"` on `proxmox_request` for endpoints returning text instead of JSON.

## Verification

```sh
bun run typecheck
bun test
bun run build
MCP_TEST_ENTRY=../dist/index.js bun test test/stdio.test.ts
```

Tests require `openssl` on PATH to generate temporary TLS certificates. They use local HTTP/HTTPS fixtures and the real MCP SDK, including a spawned stdio process, and cover CA trust, cancellation and streaming deadlines. They do not create resources on a Proxmox cluster. A live cluster and its credentials are required to verify deployment-specific ACLs and actual VM/storage operations.

The installed OmO configuration was additionally verified read-only against
PVE 9.1.6 on 2026-09-22: all six tools registered through OmO's native MCP
service, `/version` and `/nodes` succeeded, and `/access/permissions` returned
846 effective grants for the dedicated token. No mutating API operation was
performed, so VM/storage/network changes remain unverified by design.

Troubleshooting: `401` usually means a bad/expired token or disabled user; `403` means insufficient effective permissions or an endpoint that rejects API tokens. TLS errors usually require your cluster CA. Discovery failure does not imply the Proxmox API is down.

References: [Proxmox API authentication and encoding](https://pve.proxmox.com/wiki/Proxmox_VE_API), [API viewer](https://pve.proxmox.com/pve-docs/api-viewer/), [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x).

The tested old/new release and subscription-channel boundaries are recorded in
[`docs/compatibility.md`](docs/compatibility.md).
