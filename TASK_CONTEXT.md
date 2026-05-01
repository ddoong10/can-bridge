# Task Context

This file is the shared working context for Claude Code, Codex, and any other
agent working in this repository. Read it before starting work and update it
when the task state changes.

## Goal

Build `can-bridge`: a CLI and optional agent workflow for extracting,
normalizing, and handing off coding-agent conversations across tools.

## Current State (v0.1 — bidirectional, tool-call aware)

- The project is a TypeScript CLI with source in `src/` and compiled output
  in `dist/`.
- The common interchange format is `NormalizedContext` in
  `src/schema/context.ts`.
- `src/adapters/claude-code.ts` — implements **both** `SourceAdapter`
  (extract) and `TargetAdapter` (inject) for Claude Code session JSONL.
  Extract walks `parentUuid` trees and selects the latest-leaf chain.
- `src/adapters/codex.ts` — implements **both** `SourceAdapter` and
  `TargetAdapter` for Codex CLI rollout JSONL. Extract decodes the
  `[error] ` prefix back to `tool_result.isError`.
- Tool-call schemas translate at the adapter boundary:
  `tool_use`/`tool_result` ↔ `function_call`/`function_call_output`.
- `src/transform/redactor.ts` — opt-in `--redact` pattern-based secret
  scrubber for vendor API keys, JWTs, Bearer tokens, key=value pairs.
- `src/doctor/session-doctor.ts` — `harness doctor` schema-marker validator
  for Claude Code and Codex JSONL files; reports score plus mismatch list.
- `src/cli/index.ts` — `continue`, `pipe`, `export`, `import`, `list`,
  `doctor`, and `mailbox` subcommands; all four source/target combinations
  registered; `--redact` flag.
- `continue --from <source> --to <target> --latest` picks the newest source
  session by `updatedAt`, runs doctor preflight, then injects into the target
  or renders prompt fallback with `--as-prompt`.
- Smoke tests at `tests/smoke.test.mjs` — 14/14 passing.
- Shared collaboration files are now present: `AGENTS.md`,
  `TASK_CONTEXT.md`, `docs/HANDOFF.md`, `docs/DECISIONS.md`.
- A local agent mailbox exists through `harness mailbox`, backed by
  `.agent-chat/messages.jsonl` and ignored by git.
- `docs/RELATED_PROJECTS.md` tracks adjacent GitHub projects and positions
  this repo as a context interchange core, not primarily a live bridge.
- `docs/ALIAS_SHARE_SPEC.md` drafts the short alias + friend sharing design.
- The local folder is not currently initialized as a git repository.

## Shared Agent Protocol

- Codex reads `AGENTS.md`.
- Claude Code reads `CLAUDE.md`.
- Both agents read this file plus `docs/HANDOFF.md` and `docs/DECISIONS.md`.
- Before handing off, update `docs/HANDOFF.md` with what changed, what was
  verified, and what remains.
- Record durable project decisions in `docs/DECISIONS.md`.
- Do not edit Codex or Claude internal session files manually unless the user
  explicitly asks for adapter/debugging work.

## Relevant Commands

```powershell
npm run build
npm test
node dist\cli\index.js list --from claude-code
node dist\cli\index.js continue --from claude-code --to codex --latest
node dist\cli\index.js doctor --from codex --session <id-or-jsonl>
node dist\cli\index.js pipe --from claude-code --session <id> --to codex --as-prompt
node dist\cli\index.js mailbox send --from codex --to claude --body "message"
node dist\cli\index.js mailbox inbox --agent codex
```

## Active Work

Bidirectional Claude Code ⇄ Codex with tool-call schema translation is
shipped and verified end-to-end on the user's machine (forward via
`codex exec resume` recall, reverse via direct
`claude --print --resume <uuid>` recall). The current post-release iteration
also closes the `[error] ` lossy translation and
handles Claude Code `parentUuid` branches by selecting the latest-leaf chain.
`harness doctor` is implemented as a heuristic schema-drift detector for known
Claude Code and Codex JSONL markers. The local mailbox is implemented so agents
can exchange explicit messages through repo files instead of hidden context.
`docs/ALIAS_SHARE_SPEC.md` captures the alias/share design, with local storage
as MVP and Gist/server/IPFS as pluggable stores.
Friendly latest-continue is implemented and verified from Claude Code to Codex
on the user's latest local Claude session, then round-tripped back into Claude
Code and resumed successfully.

## Next Steps (v1 candidates)

1. Extend `continue` with an interactive picker when `--latest` is not desired.
2. New adapters: Cursor, ChatGPT web export, Gemini.
3. Auto-summarization for long contexts (model/target dependent).
4. Optional `stage1_outputs` sqlite registration on Codex inject to
   silence the cosmetic "thread not found" stderr line.
5. Alias/share MVP: local alias registry, `keep`, `aliases`, `show`, `forget`.
6. Public release prep: README polish, security notes, skill wrapper, and MCP
   wrapper.
7. Keep `AGENTS.md` and `CLAUDE.md` aligned on the shared protocol.
8. Add or update tests when changing adapters, schema, or transforms.
9. Consider a watch/daemon mode that polls `harness mailbox inbox` and invokes
   each agent's CLI automatically.
10. Re-scan related projects before public release, especially live
    Claude/Codex bridges and MCP wrappers.
