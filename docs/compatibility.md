# Proxmox VE compatibility

Evidence collected on 2026-09-22. **These are schema and protocol checks, not
live-cluster certification.** No cluster, credentials, VM operations, TLS setup,
or installed enterprise/no-subscription package pairs were available.

## Compatibility matrix

| Target | Token-only eligibility | Concrete evidence and limit |
| --- | --- | --- |
| Installations predating API tokens, including VE 5.x and original 6.0/6.1 releases | No | This client has no password/ticket authentication fallback. |
| Updated 6.1-era packages | Package-dependent; not certified | Token implementation predates the 6.2 release announcement; a version string alone cannot establish eligibility. See the package-history qualification below. |
| VE 6.2-6.4 | 6.2 is the documented release baseline for API tokens | Official 6.4 viewer: 504 methods parsed, searched, and described. No exact 6.2 viewer or live 6.x server was tested. |
| VE 7.x | Token authentication available | Official 7.4 viewer: 540 methods parsed, searched, and described. This does not establish compatibility with every 7.x endpoint revision. |
| VE 8.x | Token authentication available | Official 8.4.0 viewer: 605 methods parsed, searched, and described. |
| VE 9.x/current docs | Token authentication available | Current documentation index identified 9.2.12; its viewer yielded 680 methods, all parsed, searched, and described. The current URL is mutable. |
| Unreleased VE versions | No blanket guarantee | Generic paths and additional JSON metadata are tolerated; changed authentication, transport, schema grammar, methods, parameter types, or endpoint semantics can still require changes. |

The [official 6.2 release notes][roadmap] (2020-05-12) announce full API-token
support and integration. This is the documented release baseline, **not** a
claim that every pre-6.2 updated installation lacks tokens: the official
[access-control package changelog][access-history] records implementation and
management in `libpve-access-control 6.0-6`, dated 2020-01-29. That component
version is not a Proxmox VE release number, nor is that package alone sufficient
proof that the entire HTTP authentication stack supports tokens. Unupdated
pre-token installations cannot work within this project's token-only scope.

## Community, no-subscription, and enterprise

These are not distinct API editions. The [official pricing page][pricing]
explicitly says there are no separate feature editions, and the [repository
documentation][repos] describes channels for the same Proxmox VE packages:

- `pve-enterprise` requires a subscription and contains the more heavily tested
  production packages.
- `pve-no-subscription` does not require a subscription; its packages may arrive
  earlier and are not always as heavily tested and validated.
- The paid **Community subscription** includes Enterprise Repository access;
  it is not another name for the no-subscription repository.

The client uses the same `/api2/json` API and token header for each. A subscription
does not grant token ACLs or remove token-authentication exclusions. Different
installed versions, update timing, plugins, and node capabilities can expose
different endpoints and parameters; matching channel names do not establish
identical endpoint sets. No side-by-side live channel comparison was performed.

## Official viewer evidence

The complete downloaded files were served unchanged from a loopback HTTP
fixture and passed through the actual `ApiCatalog.search` and `describe`
implementation. Each method in each safely JSON-extracted tree was described
and its complete metadata compared with the source. Search returned every
method; all description comparisons matched. The downloaded viewer JavaScript
was never executed.

| Documentation index | Exact viewer URL | Bytes | Methods | Assignment |
| --- | --- | ---: | ---: | --- |
| [6.4](https://pve.proxmox.com/pve-docs-6/index.html) | [6.x viewer][schema6] | 2,663,975 | 504 | `var pveapi = [...]` |
| [7.4](https://pve.proxmox.com/pve-docs-7/index.html) | [7.x viewer][schema7] | 3,049,807 | 540 | `const apiSchema = [...]` |
| [8.4.0](https://pve.proxmox.com/pve-docs-8/index.html) | [8.x viewer][schema8] | 3,480,498 | 605 | `const apiSchema = [...]` |
| [9.2.12](https://pve.proxmox.com/pve-docs/index.html) | [Current viewer][schema-current] | 4,346,888 | 680 | `const apiSchema = [...]` |

SHA-256 of the downloaded UTF-8 bytes, in the same order:

```text
374156fc7188fb23c40982d0ff63fb7dce601f80f7319032bbb94882f47af69f
125f0af24951e901800e49559593678edd95af66da27c88311faecda708ebaf1
bbe03a42c55b3f9ae77a5b5216c1a8554f4fffd0f4b266848f4af26be295946e
68a8ac7b4994525a1df5530e2d96f4fc76b6401f07861ac8a51635a0b9ce7c53
```

No unsupported format was found in these four complete viewers. In particular,
the older `pveapi` assignment, the newer `apiSchema` assignment, a semicolon on
the following line, absolute paths inside nested `children`, and the executable
viewer suffix all work with the current non-evaluating parser. A minimal
projection of the actual 6.4 `/version` return schema is:

```javascript
var pveapi = [{
  "path": "/version",
  "info": {"GET": {"allowtoken": 1, "returns": {
    "type": "object",
    "properties": {
      "release": {"type": "string"},
      "repoid": {"type": "string"},
      "version": {"type": "string"}
    }
  }}}
]
;
```

The 7.4 `/version` return schema adds the optional `console` enum. The 8.4.0
and current schemas additionally constrain `repoid` with
`[0-9a-fA-F]{8,64}`. The current token-update schema adds `regenerate` and an
optional returned `value`; its permission expression uses `userid-group`
where 6.4 used a `perm` check on `/access/users/{userid}`. These are actual
schema differences, not the same fixture with different version strings.

Archive limitations: `https://pve.proxmox.com/pve-docs-6.2/api-viewer/apidoc.js`
returned 404. `https://enterprise.proxmox.com/pve-docs/` and `/docs/` returned
404; the attempted enterprise Buster package-directory URL returned 401.
The public HTTPS download-mirror request failed certificate hostname
verification; its HTTP directory URL returned 404. The working official
major-version documentation archives above supplied the historical evidence
instead. Their index versions identify documentation snapshots, not a
guaranteed exact package set on any customer's cluster.

## Protocol and future-compatibility boundaries

The [official API documentation][api] specifies the HTTPS API on port 8006,
`/api2/json`, URL parameters, form-encoded POST/PUT parameters, and
`Authorization: PVEAPIToken=USER@REALM!TOKENID=UUID`. API-token writes do not
require the ticket-authentication CSRF header. Proxmox property strings such as
`net0` remain strings; the client does not reinterpret their release-specific
contents.

Requests do not consult a version table or endpoint allowlist and do not
require a catalog download. `PROXMOX_SCHEMA_URL` selects the discovery schema;
it does not negotiate a server version or make an unavailable endpoint exist.
Use documentation matching the target installation, and treat the server's
response as authoritative. The default current viewer can describe features
absent from an older node.

Catalog method metadata preserves unknown JSON fields and opaque server-side
schemas, including Perl regular-expression strings and permission expressions.
It does not compile those expressions or implement Proxmox ACL decisions.
Structural requirements still apply: a recognized assignment containing a JSON
array (or raw JSON array), absolute node paths, and recognized HTTP method keys.
HTTP request tools currently accept GET, POST, PUT, and DELETE; this is not a
promise of support for arbitrary future verbs or non-JSON schema syntax.

The [API stability policy][api] aims for compatibility within a major release,
not across major releases. Added endpoints, parameters, object properties, and
certain return-shape changes are explicitly not classified as breaking changes.
Generic transport cannot compensate for removed or renamed endpoints.
`allowtoken: 1` does not imply permission to call an endpoint; `allowtoken: 0`
is a token exclusion. Both sampled endpoints `/access/ticket` POST and
`/access/password` PUT are excluded in the 6.4 and current viewers.
The [permission documentation][permissions] explains the intersection of
privilege-separated token and user permissions.

## Offline regressions and remaining verification

`test/compatibility.test.ts` contains reduced, attributed 6.4/current JSON
projections. It tests their different assignment wrappers, nested concrete-path
lookup, opaque Perl patterns, changing ACL expressions, newer parameter/return
fields, and preservation of unknown metadata. A separately labeled synthetic
future-path fixture checks that authentication and form encoding work without
catalog, release, or repository prerequisites. It does not pretend to be a
future Proxmox implementation.

Run `bun test test/compatibility.test.ts` for these seven deterministic tests;
normal test runs use only loopback fixtures and never download schemas. The
complete official-catalog checks described above were one-time evidence probes,
not online dependencies of the test suite. No production parser change or
failing compatibility regression was required for the sampled formats.

Verification on 2026-09-22: the compatibility file passed all 7 tests, its LSP
diagnostics were clean, and `bun run typecheck` exited 0. The parent fixed the
unrelated stdio test's `.env` isolation after this audit; the final complete
suite and built-process results are reported in the project README/final
delivery rather than pinned here.

The installed OmO integration was subsequently verified read-only against one
live PVE 9.1.6 host: token authentication, `/version`, `/nodes`, and
`/access/permissions` succeeded, with 846 effective permission grants. This is
current-host evidence only, not proof for other releases or repository channels.

Still unverified: token expiry behavior, mutating operations on old/new
clusters, binary/console behavior, side-by-side subscription channel package
parity, and unreleased APIs. Those require appropriate live installations;
passing schema and fixture tests is not evidence that those operations have
been performed.

[roadmap]: https://pve.proxmox.com/wiki/Roadmap#Proxmox_VE_6.2
[access-history]: https://git.proxmox.com/?p=pve-access-control.git;a=blob_plain;f=debian/changelog;hb=HEAD
[pricing]: https://www.proxmox.com/en/proxmox-virtual-environment/pricing
[repos]: https://pve.proxmox.com/pve-docs/pve-package-repos-plain.html
[api]: https://pve.proxmox.com/wiki/Proxmox_VE_API
[permissions]: https://pve.proxmox.com/pve-docs/pveum-plain.html
[schema6]: https://pve.proxmox.com/pve-docs-6/api-viewer/apidoc.js
[schema7]: https://pve.proxmox.com/pve-docs-7/api-viewer/apidoc.js
[schema8]: https://pve.proxmox.com/pve-docs-8/api-viewer/apidoc.js
[schema-current]: https://pve.proxmox.com/pve-docs/api-viewer/apidoc.js
