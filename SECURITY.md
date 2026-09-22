# Security policy

## Reporting a vulnerability

Do not open a public issue for credential exposure, token misuse, arbitrary
file access, SSRF, or an unsafe Proxmox write path. Report privately through
the repository owner's GitHub security contact with reproduction steps and
impact. Do not include live tokens, passwords, certificates, or cluster
identifiers.

## Supported version

Security fixes are applied to the latest `main` revision. The project is not
published as an npm package; consume the reviewed Git revision or release tag.

## Operational boundary

This server honors the privileges of its Proxmox API token. Operators should
use a dedicated least-privileged token, keep credentials in a mode-`0600`
environment file, and require MCP tool approval for mutating operations.
