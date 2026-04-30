# Changelog

## v0.1.0 — 2026-04-30

First public-ready release. Bidirectional Claude Code ⇄ Codex with
end-to-end verification on a real machine.

### Added

- **Bidirectional adapters**. `ClaudeCodeAdapter` and `CodexAdapter` each
  implement both `SourceAdapter` (extract) and `TargetAdapter` (inject).
  All four pipe combinations work:
  `claude-code → codex`, `codex → claude-code`,
  `claude-code → claude-code`, `codex → codex`.
- **Tool-call schema translation**. Anthropic
  `tool_use { id, name, input: object }` ↔ OpenAI
  `function_call { call_id, name, arguments: string-JSON }`.
  Anthropic `tool_result { tool_use_id, content, is_error }` ↔
  `function_call_output { call_id, output: string }` (with `[error] `
  prefix when `isError`).
- **Opt-in secret redactor** (`--redact`) with patterns for vendor API
  keys (`sk-`, `sk-ant-`, `gh*_`, `AKIA`, `AIza`, `xox*-`), JWTs, Bearer
  tokens, and `password=`/`token=` values. Walks every block type
  including nested `tool_use` input.
- **Agent mailbox** (`harness mailbox`) — JSONL-backed message queue at
  `.agent-chat/messages.jsonl` for live agent-to-agent communication
  alongside the durable `docs/HANDOFF.md` log.
- **Round-trip + reverse-direction tests** in `tests/smoke.test.mjs`
  (8 tests). Forward and reverse pipe verified against real local
  Claude Code and Codex sessions.
- **Shared collaboration protocol**: `AGENTS.md`, `CLAUDE.md`,
  `TASK_CONTEXT.md`, `docs/HANDOFF.md`, `docs/DECISIONS.md`.

### Verified end-to-end (live)

- **Claude Code → Codex**: `codex exec --skip-git-repo-check resume`
  against an injected rollout had Codex (gpt-5.5) recall the original
  Korean first message verbatim. Codex auto-registered the session in
  `~/.codex/state_5.sqlite`. The rollout file grew on write-back
  (315,213 → 319,180 bytes).
- **Codex → Claude Code**: a 158-message Codex session was injected as a
  Claude Code JSONL and showed up in `claude --resume`'s picker
  (size 288.9KB and first user message both matched).

### Known limits

- Claude Code `parentUuid` branches are flattened to file order.
- Thinking blocks are dropped on cross-tool transfer.
- Codex extract does not yet decode `[error] ` prefix back to
  `isError: true` on round-trip.
- Codex's stderr `failed to record rollout items: thread <uuid> not found`
  on first authored-rollout resume is cosmetic; main append succeeds.
