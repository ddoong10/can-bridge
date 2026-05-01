# can-bridge

> **Move your conversation between Claude Code and Codex CLI without losing
> context.** A small TypeScript CLI that extracts a session from one tool,
> normalizes it, and injects it into the other — both directions.

[![tests](https://img.shields.io/badge/tests-39%2F39%20passing-brightgreen)](#verified-behavior)
[![status](https://img.shields.io/badge/status-v0.2.1%20portable%20handoff-blue)](#what-works)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## Why

Two of the best coding agents — Anthropic's **Claude Code** and OpenAI's
**Codex CLI** — both keep your conversation history as a JSONL file on
disk. Different formats, no shared interchange. So if you want to:

- Continue a Claude Code conversation in Codex (or vice versa)
- Compare the same task across both models
- Hand a session off to a teammate using the other tool

…you have to copy-paste manually, losing tool calls, structure, and
fidelity. **can-bridge fixes this** — and goes the extra mile by translating
Anthropic's `tool_use` / `tool_result` blocks to OpenAI Responses
`function_call` / `function_call_output` items in both directions, so
agents pick up where the other left off.

> **Status: v0.2.** Source and target formats are not officially documented.
> Adapters were verified against real local files on 2026-04-30
> (Claude Code v2.1.119, Codex CLI v0.125.0 / rollout v0.126.0-alpha.8).
> Re-verify if either tool ships a format change.

## What works

|              | as **Source** (extract) | as **Target** (inject) |
|--------------|:-----------------------:|:----------------------:|
| Claude Code  | ✅                       | ✅                      |
| Codex CLI    | ✅                       | ✅                      |

Bidirectional. Tool calls (`tool_use` / `tool_result` ↔ `function_call` /
`function_call_output`) translate at the adapter boundary. Thinking blocks
are intentionally dropped (internal to the source model).

## Install

From npm:

```bash
npm install -g can-bridge
can-bridge --help
```

From GitHub main:

```bash
npm install -g https://github.com/ddoong10/can-bridge/archive/refs/heads/main.tar.gz
can-bridge --help
```

From a local checkout:

```bash
git clone https://github.com/ddoong10/can-bridge.git
cd can-bridge
npm install
npm run build
npm link
can-bridge --help
```

## Quick start

```bash
# Easiest path: continue the latest Claude Code session in Codex
can-bridge continue --from claude-code --to codex --latest
# Then run the printed command:
#   codex resume <printed-uuid>

# List recent sessions on either side, including import origin and previews
can-bridge list --from claude-code --cwd --limit 10
can-bridge list --from codex --cwd --limit 10

# Check a session file for known schema markers before trusting a conversion
can-bridge doctor --from codex --session <codex-uuid-or-jsonl>
can-bridge doctor --from claude-code --session <claude-session-id-or-jsonl>

# Forward: Claude Code → Codex
can-bridge pipe \
  --from claude-code --session <claude-session-id> \
  --to codex
# Then in a real terminal:
#   codex resume <printed-uuid>
# Or non-interactively:
#   codex exec --skip-git-repo-check resume <printed-uuid> "<prompt>"

# Reverse: Codex → Claude Code
can-bridge pipe \
  --from codex --session <codex-uuid> \
  --to claude-code
# Then in the same cwd:
#   cd <project-cwd>
#   claude --resume <printed-uuid>
# or:
#   claude --print --resume <printed-uuid> "<prompt>"
```

## Pick The Right Session

Session IDs are random UUIDs, so `list` shows human-readable context by
default:

```bash
can-bridge list --from codex --cwd --limit 10
can-bridge list --from claude-code --cwd --limit 10
```

Example output:

```text
1. 2026-05-01 17:04:04Z  019ddd6b-...  (317 messages, model: gpt-5.5)
   project: can-bridge
   cwd: D:\work\can-bridge
   latest user: "Why do several Codex sessions show the same latest user?"
   latest assistant: "They came from the same imported Claude Code session..."
   origin: can-bridge / can-bridge-import / from claude-code:8131efb2...
```

Useful flags:

- `--cwd` filters to sessions whose recorded working directory matches the
  current folder. Pass `--cwd <path>` to filter another folder.
- `--limit <n>` controls how many recent sessions are shown.
- `--all` shows every known session.
- `--json` prints machine-readable session summaries.

If several Codex sessions have the same `latest user`, they are often
separate imports/checkpoints from the same original session. Check
`latest assistant`, `message count`, and `origin` to choose the right one.

If a target rejects an authored file (rare; means the format has changed),
fall back to a portable text seed any LLM can take:

```bash
can-bridge pipe \
  --from <src> --session <id> --to <target> --as-prompt > seed.md
```

## Share with a friend (`.cbctx`)

`pipe` only works on the same machine. To send a conversation to a
teammate over Slack/email/Discord, package it as a portable `.cbctx`
file. The receiver imports it into whichever tool they use (Claude Code
or Codex).

**Sender:**

```bash
cd <project>

can-bridge share \
  --from <codex|claude-code> --latest --redact \
  --include-repo-ref --include-patch \
  --out handoff.cbctx
# → Wrote my-session.cbctx (484 messages, repo: 731842b...)
# → Share this file with your friend.
```

Send `handoff.cbctx` over KakaoTalk, Slack, email, Discord, or any file
transfer channel.

**Receiver (any machine, any folder name, either tool):**

The receiver should open or clone the same repository, but the absolute path
and folder name do **not** need to match the sender's machine.

```bash
npm install -g can-bridge

# The folder name can be different from the sender's folder.
git clone <repo-url> <any-folder-name>
cd <any-folder-name>
```

Import into Codex:

```bash
can-bridge import --to codex --in ~/Downloads/handoff.cbctx
#   Originally from claude-code (claude-opus-4-7), 484 messages.
#   Original session: 8131efb2-...
#   Original cwd: C:\Users\ddoon\Desktop\context_switching
#   Repo: github.com/ddoong10/can-bridge (branch main) @ 731842b...
#   Doctor (at share time): ok 100/100
#   Doctor (preflight on import): ok 100/100
# → Injected to: ~/.codex/sessions/.../rollout-...jsonl
codex resume <printed-uuid>
```

Or import into Claude Code:

```bash
can-bridge import --to claude-code --in ~/Downloads/handoff.cbctx
claude --resume <printed-uuid>
```

The `.cbctx` file location doesn't matter — what matters is **the cwd
you `cd` into before running `import`**. That cwd is where the new
session ends up. A different username, parent directory, drive, or folder
name is fine as long as the receiver is inside the intended project repo.

If the receiver imports from a random folder, the conversation still imports,
but the agent may not find the referenced files. Pass `--cwd <path>` to set a
specific receiver cwd. Avoid `--keep-source-cwd` unless the receiver really
has the sender's original path.

What goes in the `.cbctx` (`can-bridge.context.v1` schema):

- `source` — which tool / model / sessionId / cwd the conversation came from
- `messages` — normalized transcript (Anthropic-style blocks)
- `redaction` — flags + per-kind counts of secrets that were masked
- `repo` (opt-in) — git remote / branch / commit so the receiver can
  `git checkout` the same code state. Add `--include-patch` to bundle
  the dirty diff too.
- `doctor` — schema-validity score captured at share time, surfaced
  during import alongside a fresh preflight check
- `harnessVersion`, `createdAt`
- `contentHash` — sha256 over canonical(source + summary + messages).
  Importer rejects mismatched or missing hashes by default; pass
  `--skip-hash-verify` only when you trust the source over an out-of-band
  channel.

Both inject paths (Claude Code and Codex) prepend an **untrusted-content
fence** so the resuming agent treats the imported transcript as data, not
as instructions. Round-trips strip and re-emit the fence cleanly so it
never accumulates.

Receiver-side import auto-detects the file format — pass either a
`.cbctx` package or a plain NormalizedContext JSON to `--in`.

## Agent mailbox

Claude Code and Codex cannot directly share hidden model state, but they can
talk through a local mailbox file. The default mailbox is
`.agent-chat/messages.jsonl`, which is ignored by git.

```bash
# Codex asks Claude Code to review something
can-bridge mailbox send \
  --from codex --to claude \
  --subject "adapter review" \
  --body "Please review the Codex adapter tests and reply in this thread."

# Claude Code reads its inbox
can-bridge mailbox inbox --agent claude

# Claude Code replies in the same thread
can-bridge mailbox send \
  --from claude --to codex \
  --thread <thread-id> \
  --reply-to <message-id> \
  --body "Reviewed. Add one regression test for mailbox threading."

# Codex reads the full thread
can-bridge mailbox thread --thread <thread-id>
```

Use `docs/HANDOFF.md` for durable handoffs. Use the mailbox for live,
short-lived agent conversation.

## Related work

This space already has live Claude/Codex bridges, MCP wrappers, editor sync
extensions, and persistent memory systems. can-bridge is positioned as a
loss-aware context interchange core rather than a live-agent router. See
[docs/RELATED_PROJECTS.md](docs/RELATED_PROJECTS.md) for the current scan.

## Verified behavior

`npm test` runs `tests/smoke.test.mjs` end-to-end against real local
sessions (skips if absent). It verifies:

1. **Forward** — Claude Code → Codex round-trip preserves text and tool calls.
2. **Reverse** — Codex → Norm correctly parses real `function_call` items
   from rollouts written by `codex_vscode`.
3. **Round-trip via Claude Code** — text + `tool_use` + `tool_result` survive
   through `inject → re-extract` with id, name, input, output preserved.
4. **Round-trip via Codex** — same blocks survive `inject → re-extract` with
   `call_id` and `[error] ` / `isError` preserved.
5. **Claude Code branches** — `parentUuid` trees reconstruct the latest-leaf
   chain instead of blindly flattening file order.
6. **Agent mailbox** — local mailbox send, inbox, thread, and all-message
   flows are covered.
7. **Doctor** — known Claude Code and Codex JSONL markers produce
   compatibility scores and mismatch codes.
8. **Continue command** — `--latest` selects the newest source session by
   `updatedAt` and runs doctor preflight before injection.
9. **Human-readable session list** — `list` shows newest sessions with cwd,
   project, message count, model, latest user/assistant previews, and import
   origin when available.

### Live end-to-end demos (2026-04-30)

- **Claude Code → Codex**: `codex exec --skip-git-repo-check resume <uuid>
  "<prompt>"` against an injected rollout was confirmed to locate the
  file by UUID, recall the original first message verbatim, auto-register
  a row in `~/.codex/state_5.sqlite` on first resume, and append the new
  turn back to the rollout file on disk.
- **Friendly latest continue**: `can-bridge continue --from
  claude-code --to codex --latest` selected the latest Claude Code session,
  passed doctor preflight, extracted 409 messages, and wrote a resumable
  Codex rollout.
- **Codex → Claude Code**: a 158-message Codex session was injected as
  `~/.claude/projects/<cwd>/<uuid>.jsonl`, showed up in `claude
  --resume`'s picker, and current Claude Code also supports direct
  `claude --resume <uuid>` / `claude --print --resume <uuid> "<prompt>"`
  resume by session id.

The stderr line `failed to record rollout items: thread <uuid> not found`
on first Codex resume is cosmetic — it comes from a *secondary* table
sync (memory/summary cache); the main rollout append still succeeds.

## Tool-call schema mapping

| Anthropic block (Claude Code)                       | OpenAI Responses item (Codex)                                  |
|-----------------------------------------------------|---------------------------------------------------------------|
| `tool_use { id, name, input: object }`              | `function_call { call_id, name, arguments: string-JSON }`     |
| `tool_result { tool_use_id, content, is_error }`    | `function_call_output { call_id, output: string }` (with `[error] ` prefix when `is_error`) |

The `arguments` field on the OpenAI side is a JSON-encoded **string**, not
an object. The `is_error` flag on the Anthropic side has no OpenAI
counterpart and is encoded into the output text.

## Known v0.2 limits

- **Claude Code branches** — when a session has multiple `parentUuid`
  branches, we follow the **latest-leaf chain** (newest leaf by
  timestamp, walking back to root). Older sibling branches are dropped.
  Single-chain sessions behave exactly as before.
- **Thinking blocks are dropped on cross-tool transfer AND on Claude Code
  inject.** They are signed artifacts of the source model; empty
  signatures get rejected on the receiving side.
- **`source: "can-bridge-import"`** in our `session_meta.payload.source`
  falls back to `"unknown"` in Codex's `threads` table because Codex
  doesn't recognize the originator string. No functional impact.
- **Claude Code resume by id depends on CLI version.** Current versions expose
  `claude --resume <uuid>` and `claude --print --resume <uuid> "<prompt>"`;
  older versions may require choosing the injected file from `claude --resume`.
- **`can-bridge doctor` is heuristic.** It catches known structural drift before
  conversion, but it is not a formal vendor schema validator and should be
  updated whenever local Claude Code or Codex formats change.

## Architecture

```
Source tool   →  NormalizedContext  →  Target tool
                 (src/schema/context.ts)
   extract()                            inject()
   SourceAdapter                        TargetAdapter
   src/adapters/*.ts                    src/adapters/*.ts
```

Each adapter file implements one or both interfaces from
`src/adapters/base.ts`. Adding a tool = adding one file.

## Layout

```
src/
  schema/context.ts            NormalizedContext type (the lingua franca)
  adapters/
    base.ts                    Adapter interfaces
    claude-code.ts             Claude Code source + target
    codex.ts                   Codex CLI source + target
  cli/index.ts                 can-bridge CLI
  collab/mailbox.ts            Local agent mailbox
  doctor/session-doctor.ts     Session schema marker checks
tests/
  smoke.test.mjs               Round-trip, doctor, and mailbox tests
docs/
  ALIAS_SHARE_SPEC.md          Short alias + friend sharing design
  OPEN_QUESTIONS.md            Format questions: resolved vs still open
  PRESENTATION_NOTES.md        Talking points for live demo / writeup
  RELATED_PROJECTS.md          Adjacent projects and positioning notes
```
