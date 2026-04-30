# Decision Log

This file records durable decisions for the context handoff project. Keep
entries short and append new decisions as they become stable.

## D-0001 - Use Shared Files As Collaboration Ground Truth

Claude Code and Codex do not share hidden model context. The project uses
repository files as the shared state:

- `TASK_CONTEXT.md` for current work state.
- `docs/HANDOFF.md` for agent-to-agent handoff entries.
- `docs/DECISIONS.md` for durable decisions.
- `CLAUDE.md` for Claude Code instructions.
- `AGENTS.md` for Codex instructions.

## D-0002 - Keep Internal Session Mutation Experimental

Directly writing Codex or Claude internal session files is useful for adapter
research, but it is not the default collaboration mechanism. The safer default
is prompt or Markdown handoff generated from normalized context.

## D-0003 - Keep The CLI As The Product Core

The open-source artifact should center on a testable CLI and adapter library.
Agent skills or editor integrations should be thin wrappers around the CLI and
shared workflow.

## D-0004 - One Adapter File Implements Both Directions

For each tool we support, a single adapter file/class implements both
`SourceAdapter` and `TargetAdapter`. Format knowledge lives in one place
per tool, not split across `<tool>-source.ts` and `<tool>-target.ts`. The
extract/inject methods can share helpers (e.g. block-shape constants).
Verified workable for both Claude Code (claude-code.ts) and Codex
(codex.ts).

## D-0005 - Tool Calls Translate At The Adapter Boundary, Not In The Schema

`NormalizedContext` carries Anthropic-style `tool_use` and `tool_result`
blocks (object `input`, separate `is_error` flag). The Codex adapter
converts to/from OpenAI Responses items (`function_call` with stringified
`arguments`, `function_call_output` with `[error] ` prefix encoding the
error flag) at extract/inject. Reasoning: Anthropic's shape is structurally
richer (typed blocks) so it survives round-trips better as the canonical
form. The `[error] ` prefix on inject is the explicit lossy translation;
extract currently does NOT decode it back (open work item).

## D-0006 - Redaction Is Opt-In, Pattern-Based, And High-Confidence Only

`--redact` is opt-in (not default-on) because legitimate conversations
about API examples are common in coding-agent transcripts. Patterns
target *vendor-prefixed* shapes (`sk-ant-`, `sk-`, `gh*_`, `AKIA`,
`AIza`, `xox*-`), structural shapes (JWT, Bearer), and explicit key=value
pairs. We deliberately reject low-confidence heuristics like "any 32-char
hex" — too many false positives (commit hashes, file digests, UUIDs).
