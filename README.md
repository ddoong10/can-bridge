# can-bridge

> **Move your conversation between Claude Code and Codex CLI without losing
> context.** A small TypeScript CLI that extracts a session from one tool,
> normalizes it, and injects it into the other — both directions.

[![tests](https://img.shields.io/badge/tests-8%2F8%20passing-brightgreen)](#verified-behavior)
[![status](https://img.shields.io/badge/status-v0.1%20bidirectional-blue)](#what-works)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## Why

Two of the best coding agents — Anthropic's **Claude Code** and OpenAI's
**Codex CLI** — both keep your conversation history as a JSONL file on
disk. Different formats, no shared interchange. So if you want to:

- Continue a Claude Code conversation in Codex (or vice versa)
- Compare the same task across both models
- Hand a session off to a teammate using the other tool

…you have to copy-paste manually, losing tool calls, structure, and
fidelity. **Harness fixes this** — and goes the extra mile by translating
Anthropic's `tool_use` / `tool_result` blocks to OpenAI Responses
`function_call` / `function_call_output` items in both directions, so
agents pick up where the other left off.

> **Status: v0.1.** Source and target formats are not officially documented.
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

## Quick start

```bash
npm install
npm run build

# List sessions on either side
node dist/cli/index.js list --from claude-code
node dist/cli/index.js list --from codex

# Forward: Claude Code → Codex
node dist/cli/index.js pipe \
  --from claude-code --session <claude-session-id> \
  --to codex
# Then in a real terminal:
#   codex resume <printed-uuid>
# Or non-interactively:
#   codex exec --skip-git-repo-check resume <printed-uuid> "<prompt>"

# Reverse: Codex → Claude Code
node dist/cli/index.js pipe \
  --from codex --session <codex-uuid> \
  --to claude-code
# Then in the same cwd:
#   cd <project-cwd>
#   claude --resume     # session appears in the picker
```

If a target rejects an authored file (rare; means the format has changed),
fall back to a portable text seed any LLM can take:

```bash
node dist/cli/index.js pipe \
  --from <src> --session <id> --to <target> --as-prompt > seed.md
```

## Agent mailbox

Claude Code and Codex cannot directly share hidden model state, but they can
talk through a local mailbox file. The default mailbox is
`.agent-chat/messages.jsonl`, which is ignored by git.

```bash
# Codex asks Claude Code to review something
node dist/cli/index.js mailbox send \
  --from codex --to claude \
  --subject "adapter review" \
  --body "Please review the Codex adapter tests and reply in this thread."

# Claude Code reads its inbox
node dist/cli/index.js mailbox inbox --agent claude

# Claude Code replies in the same thread
node dist/cli/index.js mailbox send \
  --from claude --to codex \
  --thread <thread-id> \
  --reply-to <message-id> \
  --body "Reviewed. Add one regression test for mailbox threading."

# Codex reads the full thread
node dist/cli/index.js mailbox thread --thread <thread-id>
```

Use `docs/HANDOFF.md` for durable handoffs. Use the mailbox for live,
short-lived agent conversation.

## Verified behavior

`npm test` runs `tests/smoke.test.mjs` end-to-end against real local
sessions (skips if absent). It verifies:

1. **Forward** — Claude Code → Codex round-trip preserves text and tool calls.
2. **Reverse** — Codex → Norm correctly parses real `function_call` items
   from rollouts written by `codex_vscode`.
3. **Round-trip via Claude Code** — text + `tool_use` + `tool_result` survive
   through `inject → re-extract` with id, name, input, output preserved.
4. **Round-trip via Codex** — same blocks survive `inject → re-extract` with
   `call_id` preserved.

### Live end-to-end demos (2026-04-30)

- **Claude Code → Codex**: `codex exec --skip-git-repo-check resume <uuid>
  "<prompt>"` against an injected rollout was confirmed to locate the
  file by UUID, recall the original first message verbatim, auto-register
  a row in `~/.codex/state_5.sqlite` on first resume, and append the new
  turn back to the rollout file on disk.
- **Codex → Claude Code**: a 158-message Codex session was injected as
  `~/.claude/projects/<cwd>/<uuid>.jsonl` and **shows up in `claude
  --resume`'s picker** (verified by file-size match and first-message
  match). Pick it from the picker to continue the conversation in Claude.

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

## Known v0.1 limits

- **Branches are not handled.** Claude Code uses `parentUuid` to record
  conversation trees; we iterate file order. Multi-branch sessions get
  flattened.
- **Thinking blocks are dropped on cross-tool transfer.** They are signed
  artifacts of the source model and don't make sense in another model's
  context.
- **`source: "harness-import"`** in our `session_meta.payload.source` falls
  back to `"unknown"` in Codex's `threads` table. No functional impact.
- **Auto-resume by id is not exposed by Claude Code.** The injected file
  shows up in `claude --resume`'s picker; user picks manually.

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
  cli/index.ts                 harness CLI
tests/
  smoke.test.mjs               Round-trip + reverse-direction tests
docs/
  OPEN_QUESTIONS.md            Format questions: resolved vs still open
  PRESENTATION_NOTES.md        Talking points for live demo / writeup
```
