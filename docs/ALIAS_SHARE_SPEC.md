# Alias Share Design Spec

Status: v1 file-share **IMPLEMENTED** — `harness share` / `harness import`
write and read a `can-bridge.context.v1` `.cbctx` package with optional
redaction, repo metadata (`--include-repo-ref` / `--include-patch`), and
embedded doctor verdict. v2 (Gist short-key) and v3 (server) remain
planned.
Date: 2026-05-01

## Problem

Users may want to keep a converted or summarized context under a short key and
share it with a friend:

```bash
harness keep auth-refactor --from codex --session 019d...
harness share auth-refactor --with friend@example.com
harness open auth-refactor
```

The key should be memorable, the content should be recoverable across machines,
and sharing should not require copy-pasting a long JSON file or raw session
path.

## Prior Art

- GitHub Gist: easy to create, clone, fork, and share. GitHub documents that
  secret gists are not searchable but are still accessible to anyone who gets
  the URL, so they are not a private sharing primitive.
- `gh gist create`: good CLI shape. It accepts stdin, multiple files,
  `--desc`, and `--public`; default is secret.
- Gist REST API: supports create/update/delete and authenticated writes.
  API responses may truncate large file content, so large contexts should use
  raw URLs or git clone if Gist is selected.
- Encrypted pastebin tools: useful model for client-side encryption, expiry,
  and one-time reads. The server should not need plaintext to route content.
- IPFS/pinning: content-addressed and portable, but pinning is required to keep
  content available. It is better as an optional backend than the default.

References:

- https://docs.github.com/en/get-started/writing-on-github/editing-and-sharing-content-with-gists/creating-gists
- https://cli.github.com/manual/gh_gist_create
- https://docs.github.com/en/rest/gists/gists
- https://docs.ipfs.tech/quickstart/pin-cli/

## Goals

- Stable short aliases: `auth-refactor`, `demo-1`, `alice/api-plan`.
- Friend sharing by link or explicit recipient.
- Backing-store pluggability: local file, Gist, server, IPFS later.
- Optional expiry and revocation.
- Redaction/encryption first, because context often contains secrets.
- Works without a hosted service for MVP.

## Non-Goals

- Real-time collaboration.
- Multi-user ACL enforcement without a server.
- Strong privacy for raw secret Gist URLs. A secret Gist URL is bearer access,
  not private authorization.
- Replacing `harness pipe`; alias/share wraps exported contexts.

## Recommended MVP

Use a local alias registry plus pluggable stores:

```text
~/.can-bridge/
  aliases.json
  shares/
    <share-id>.json
```

Default store:

- `local`: writes encrypted or redacted context files under `~/.can-bridge`.

Optional store:

- `gist`: creates a secret Gist containing an encrypted payload and a small
  README.

Later stores:

- `server`: hosted alias resolution, auth, expiry, analytics, revocation.
- `ipfs`: content-addressed encrypted payload; requires pinning.

This keeps the first release useful without committing to infrastructure.

## Data Model

Alias registry:

```json
{
  "version": 1,
  "aliases": {
    "auth-refactor": {
      "alias": "auth-refactor",
      "target": "share_01H...",
      "store": "local",
      "createdAt": "2026-05-01T00:00:00.000Z",
      "updatedAt": "2026-05-01T00:00:00.000Z",
      "source": {
        "tool": "codex",
        "sessionId": "019d..."
      },
      "labels": ["api", "handoff"]
    }
  }
}
```

Share manifest:

```json
{
  "version": 1,
  "id": "share_01H...",
  "kind": "normalized-context",
  "createdAt": "2026-05-01T00:00:00.000Z",
  "expiresAt": "2026-05-08T00:00:00.000Z",
  "store": {
    "type": "gist",
    "url": "https://gist.github.com/..."
  },
  "encryption": {
    "mode": "none | passphrase | age",
    "recipientHints": ["alice@example.com"]
  },
  "payload": {
    "encoding": "json",
    "schema": "NormalizedContext@0.1",
    "sha256": "..."
  }
}
```

## CLI Shape

Create or update alias:

```bash
harness keep <alias> --from codex --session <id> [--redact]
harness keep <alias> --in context.json
harness keep <alias> --from claude-code --session <id> --tail 20
```

List and inspect:

```bash
harness aliases
harness show <alias>
harness open <alias> --as-prompt
```

Share:

```bash
harness share <alias> --store gist --expires 7d
harness share <alias> --store gist --encrypt passphrase
harness share <alias> --with alice@example.com --encrypt age
```

Import from share:

```bash
harness fetch <share-url-or-id> --as <alias>
harness pipe --from share --session <alias> --to codex
```

Delete or revoke:

```bash
harness forget <alias>
harness revoke <alias>
```

## Backing Store Comparison

| Store | Strengths | Weaknesses | Fit |
|-------|-----------|------------|-----|
| Local file | No service, simple, private by default | Hard to share across machines | MVP default |
| Secret Gist | Familiar, easy link sharing, no backend to run | Secret URL is bearer access; no native expiry; size/truncation caveats | Good optional MVP store for encrypted payloads |
| Hosted server | Real expiry, revocation, auth, short URLs, friend ACLs | Infra, abuse handling, privacy obligations | v1+ if adoption appears |
| IPFS | Content addressing, portable, backend-neutral | Requires pinning, no deletion semantics, public retrieval by CID unless encrypted | Optional advanced store |

## Alias Rules

- Allowed: lowercase letters, digits, `.`, `_`, `-`, `/`.
- Max length: 80 characters.
- Normalize aliases to lowercase.
- Reserve prefixes: `share_`, `gist:`, `ipfs:`, `http:`, `https:`.
- Avoid implicit overwrite unless `--force` is provided.

Examples:

- `auth-refactor`
- `alice/api-plan`
- `demo.2026-05-01`

## Expiry And Revocation

Local store:

- `expiresAt` is enforced by the CLI on read.
- `revoke` deletes the payload and removes the alias.

Gist store:

- `expiresAt` is advisory unless the CLI owns a token and can delete/update the
  Gist later.
- `revoke` can delete the Gist only if the user still has write access.
- Never promise strong revocation for copied payloads.

Server store:

- Enforce expiry on read.
- Support one-time read, max-read count, per-recipient tokens, and audit log.

IPFS store:

- Expiry is advisory only.
- Revocation is impossible for already-pinned encrypted blobs; rotate keys or
  delete local alias only.

## Auth And Encryption

MVP:

- Default to `--redact` suggestions before sharing.
- Support `--encrypt passphrase` for encrypted Gist/local payloads.
- Store no passphrase in alias metadata.

Better v1:

- Support `age` recipients:
  `harness share auth-refactor --encrypt age --recipient age1...`
- Friend book:
  `~/.can-bridge/friends.json` maps names to public keys.

Server:

- Magic-link or GitHub OAuth for user identity.
- Per-share bearer token for link access.
- Optional recipient ACLs for authenticated access.

## Recommended Implementation Order

1. Local alias registry over existing `NormalizedContext`.
2. `keep`, `aliases`, `show`, `forget`.
3. `share --store gist` with encrypted payload only.
4. `fetch` from local/Gist manifest.
5. Friend book and `age` encryption.
6. Hosted server only after real usage proves the need.

## Open Questions

- Should alias payloads store full `NormalizedContext`, prompt fallback text, or
  both?
- Should `keep` support `--tail N` before the summarizer exists?
- Is `share --store gist --encrypt passphrase` acceptable for first public
  release, or should sharing require public-key encryption only?
- Should friend identities be email-like labels, GitHub usernames, or local
  aliases with keys?
