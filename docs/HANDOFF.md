# Handoff Log

Use this file to pass work between Claude Code, Codex, and other agents. New
entries go at the top.

## 2026-04-30 - Codex

### Status

Added and verified a local agent mailbox protocol.

### Changed

- Added `src/collab/mailbox.ts`.
- Added `harness mailbox send|inbox|thread|all`.
- Added `.agent-chat/` to `.gitignore`.
- Documented mailbox usage in `README.md`.
- Added mailbox coverage to `tests/smoke.test.mjs`.

### Verified

- `npm test`: 8/8 pass.
- `tsc`: passed through `npm run build`.

### Next Agent

- Use `harness mailbox` for live agent-to-agent messages.
- Use `docs/HANDOFF.md` for durable handoff summaries.
- A future daemon can poll the mailbox and invoke Claude/Codex CLIs
  automatically.

## 2026-04-30 - Claude Code (later same day)

### Status

v0.1 shipped: bidirectional adapters, tool-call schema translation, opt-in
secret redaction. End-to-end verified in BOTH directions on the user's
machine.

### Changed

- `src/adapters/claude-code.ts` — added `inject()` so Claude Code is now
  both source and target. Writes `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`
  with the wrapper shape `{type, uuid, parentUuid, timestamp, sessionId,
  cwd, version, message}` and a parentUuid chain. The cwd encoder
  replaces `:`, `\\`, `/`, AND `_` with `-` (the underscore mapping is
  non-obvious and undocumented upstream).
- `src/adapters/codex.ts` — added `extract()` + `listSessions()`. Now
  `messageToResponseItems()` fans out one NormalizedMessage with mixed
  blocks into multiple Codex response_items (text → message item, each
  tool_use → function_call, each tool_result → function_call_output).
- `src/transform/redactor.ts` — NEW. Pattern-based opt-in redactor for
  vendor API keys (sk-, sk-ant-, gh*_, AKIA, AIza, xox*-), JWTs, Bearer
  tokens, and key=value secrets. Walks every block type plus tool_use
  nested input. Replaces with `[REDACTED:<kind>]`.
- `src/cli/index.ts` — registered both adapters as both source AND target.
  Added `--redact` flag to export/import/pipe.
- `tests/smoke.test.mjs` — expanded from 2 to 7 tests: round-trip
  preservation in both directions, real `function_call` parsing, redactor
  pattern coverage, redactor block walker.
- `README.md`, `docs/OPEN_QUESTIONS.md`, `docs/PRESENTATION_NOTES.md` —
  updated for bidirectional + tool calls + redact + Codex→Claude Code
  picker verification.
- `docs/DECISIONS.md` — added D-0004, D-0005, D-0006.

### Verified

- `npm test`: 7/7 pass.
- `npx tsc`: 0 errors under strict + noUncheckedIndexedAccess.
- Live demo, forward: `codex exec --skip-git-repo-check resume <uuid>
  "<prompt>"` against an injected rollout — gpt-5.5 recalled the
  original Korean first message verbatim. File grew on write-back
  (315,213 → 319,180 bytes).
- Live demo, reverse: a 158-message Codex session was injected as a
  Claude Code JSONL and **showed up in `claude --resume`'s picker**
  (size 288.9KB and first user message both matched).
- `--redact` CLI integration: side-by-side run produced
  `[REDACTED:openai-key]` and `[REDACTED:anthropic-key]` in the redacted
  rollout while the control rollout kept the keys verbatim.

### Next Agent

- v1 candidates left in OPEN_QUESTIONS.md: parentUuid branch handling,
  Cursor / ChatGPT export / Gemini adapters, auto-summarization for long
  contexts, Codex extract decoding `[error] ` prefix back to
  `isError: true` for full round-trip fidelity.
- The Codex memory/summary cache `stage1_outputs` is still uncached for
  authored rollouts — cosmetic stderr remains. Not blocking.

## 2026-04-30 - Codex

### Status

Set up the shared collaboration protocol for this repository.

### Changed

- Added `TASK_CONTEXT.md` as the shared task state.
- Added `AGENTS.md` as Codex-facing repo instructions.
- Added `docs/HANDOFF.md` for agent-to-agent handoffs.
- Added `docs/DECISIONS.md` for durable project decisions.
- Updated `CLAUDE.md` to point Claude Code at the same shared files.

### Verified

- File structure was inspected.
- Added collaboration files were checked for presence.
- `CLAUDE.md` contains the shared collaboration section.
- No git status is available because the folder is not currently a git repo.

### Next Agent

- Read `TASK_CONTEXT.md`, `docs/HANDOFF.md`, and `docs/DECISIONS.md` before
  changing files.
- Run `npm test` after code changes.
- Update this handoff log before yielding.
