# Handoff Log

Use this file to pass work between Claude Code, Codex, and other agents. New
entries go at the top.

## 2026-04-30 - Claude Code (post-release iteration)

### Status

Closed the round-trip lossy translations and added Claude Code branch
handling. 11/11 smoke tests passing. Cross-checked the niche with Codex.

### Changed

- `src/adapters/codex.ts` — `responseItemToMessage()` now decodes the
  `[error] ` prefix on `function_call_output` payloads back to
  `tool_result.isError = true`. Norm → Codex → Norm preserves the error
  flag verbatim (was previously lossy).
- `src/adapters/claude-code.ts` — `extract()` rewritten to walk
  `parentUuid` trees instead of file order: indexes every line, walks
  past non-message intermediaries (attachment / permission-mode /
  file-history-snapshot), finds all leaves, picks the leaf with the
  latest timestamp, and reconstructs the chain back to root. Single-chain
  files are byte-for-byte identical to the previous behavior
  (regression-tested).
- `tests/smoke.test.mjs` — added 3 tests (8 → 11):
  isError round-trip, branch latest-leaf reconstruction, linear
  single-chain regression guard.
- `README.md` — added a "Related work" section citing
  `ai-session-bridge`, `codex-bridge-mcp`, `ccb` (concrete prior-art),
  updated branches/limits text to reflect the new behavior, and noted
  the planned `harness doctor` subcommand.
- `docs/OPEN_QUESTIONS.md` — moved isError + branches to "Resolved",
  added prior-art section, added `harness doctor` to Still unresolved.

### Verified

- `npm test`: 11/11 pass.
- `npx tsc`: 0 errors.
- Round-trip tests use synthetic JSONL fixtures so they're hermetic
  (no dependency on the user's local sessions).

### Codex cross-check (background ask_codex)

Codex returned three concrete prior-art repos and called out a single
likely v1 blocker: a `harness doctor` schema-drift detector. Captured as
a v1 task. Codex also recommended re-positioning the README as
"multi-agent handoff infrastructure" rather than a pure converter
utility — partially adopted (Related work section + doctor language);
the headline currently keeps the utility framing for clarity. Worth
revisiting when the project actually has multi-agent demos to show.

### Next Agent

- v1 task at the top of the queue: `harness doctor` (schema-drift
  detector) — see OPEN_QUESTIONS.md for the rationale.
- If you adopt the "multi-agent handoff infrastructure" positioning, the
  README headline + first paragraph need a coordinated rewrite.

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
