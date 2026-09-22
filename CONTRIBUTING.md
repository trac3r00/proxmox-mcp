# Contributing

## Local checks

Use Bun 1.3 or newer:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

Add a deterministic regression test before changing behavior. Tests use local
fixtures; do not require a Proxmox cluster or commit credentials, certificates,
or `.env` files.

## Security-sensitive changes

Preserve the token redaction, HTTPS-by-default, API path validation, response
limits, and transfer-root boundaries. Changes to file transfers, redirects,
TLS, authentication, or write methods require a security-focused regression
test and documentation update.
