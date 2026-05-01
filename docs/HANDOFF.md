# Handoff Log

Use this file to pass work between Claude Code, Codex, and other agents. New
entries go at the top.

## 2026-05-01 - Codex

### Status

Prepared public/global install UX for `can-bridge`.

### Changed

- Bumped package metadata to `can-bridge@0.2.0`.
- Added official npm bin `can-bridge`, keeping `harness` as a legacy alias.
- Added `prepare: npm run build` so GitHub installs build `dist` automatically:
  `npm install -g github:ddoong10/can-bridge`.
- Updated README quickstart/share/mailbox examples to use `can-bridge`.
- Fixed CLI direct-run detection for npm global shims by comparing resolved
  realpaths; `can-bridge --help`, `harness --help`, and
  `node dist\cli\index.js --help` now all run the same CLI.
- Set `.cbctx` package harness version to `0.2.0`.

### Verified

- `npm test`: 20/20 pass.
- `npm pack --dry-run`: package `can-bridge-0.2.0.tgz`, 50 files, bin-ready.
- `npm install -g .`: installed successfully on this machine.
- `can-bridge --help` and `harness --help`: both print the CLI help.

## 2026-05-01 - Claude Code (sqlite pre-registration)

### Status

Closed the "TUI `codex resume <id>` says No saved session found on first try"
issue the user hit. inject() now pre-registers a row in
`~/.codex/state_5.sqlite threads`, so the TUI sees the session immediately
without an `exec resume` bootstrap step.

### Changed

- `src/adapters/codex.ts` — added `tryRegisterCodexThread()`. Uses the
  built-in `node:sqlite` module (Node 22.5+). INSERT OR REPLACE into the
  `threads` table with the same columns Codex itself populates on first
  resume (id, rollout_path, cwd, title, first_user_message, model, etc.).
  Hint message reflects success or fallback. Silent degrade if sqlite
  isn't loadable — rollout file is still written and `codex exec resume`
  bootstraps the row as before.

### Verified

- 14/14 smoke tests still pass.
- Live: `harness pipe --from claude-code --session ... --to codex` printed
  the new "Could not pre-register in sqlite: node:sqlite not loadable"
  fallback hint on this Node 22.11 machine (no NODE_OPTIONS set), exactly
  as designed.

### Next Agent

- Node 22.x users currently need `NODE_OPTIONS=--experimental-sqlite` for
  auto-registration. Consider a small `bin/harness.js` wrapper that
  re-spawns with the flag, so the experience is transparent across Node
  versions.

## 2026-05-01 - Codex

### Status

Verified live bidirectional resume after Claude quota recovered.

### Changed

- Updated the Claude Code injection hint to use current CLI support for
  `claude --resume <uuid>` and `claude --print --resume <uuid> "<prompt>"`,
  with the interactive picker as fallback.
- Updated README/presentation notes to stop claiming Claude Code cannot
  auto-resume by id.

### Verified

- `node dist\cli\index.js continue --from claude-code --to codex --latest`:
  selected Claude session `8131efb2-19ac-407b-a538-8d94a94258e5`, doctor ok,
  extracted 410 messages, and wrote Codex rollout
  `6429971a-5bb2-41aa-93dc-c26f3e4a9512`.
- `codex exec --skip-git-repo-check resume 6429971a-5bb2-41aa-93dc-c26f3e4a9512
  "<prompt>"`: live Codex answered `can-bridge`, proving the imported
  context was readable.
- `node dist\cli\index.js continue --from codex --to claude-code --session
  6429971a-5bb2-41aa-93dc-c26f3e4a9512`: doctor ok, extracted 644 messages,
  and wrote Claude session `c2c7b876-99db-45a4-a50b-5d1a7ed88d18`.
- `node dist\cli\index.js doctor --from claude-code --session
  c2c7b876-99db-45a4-a50b-5d1a7ed88d18`: ok, 100/100, 644/644 lines parsed.
- `claude --print --resume c2c7b876-99db-45a4-a50b-5d1a7ed88d18 --model sonnet
  --max-budget-usd 1 "<prompt>"`: live Claude answered `can-bridge`, proving
  the imported Codex context was readable by Claude Code.
- `npm test`: 14/14 pass after rebuilding.

## 2026-05-01 - Codex

### Status

Implemented the friendly latest-continue command.

### Changed

- Added `harness continue --from <source> --to <target> --latest`.
- The command picks the newest source session by `updatedAt`, runs doctor
  preflight, extracts context, then injects into the target.
- Supports `--as-prompt` fallback and `--redact`.
- Exported `pickLatestSession()` for regression coverage.
- Updated `README.md` and `TASK_CONTEXT.md`.

### Verified

- `npm test`: 14/14 pass.
- `node dist\cli\index.js continue --from claude-code --to codex --latest --as-prompt`:
  selected `8131efb2-19ac-407b-a538-8d94a94258e5`, doctor ok, extracted 409
  messages, rendered prompt.
- `node dist\cli\index.js continue --from claude-code --to codex --latest`:
  wrote Codex rollout
  `C:\Users\ddoon\.codex\sessions\2026\05\01\rollout-2026-05-01T08-41-46-537Z-f4e4a25a-9cc8-4174-a2f1-2c507271ff03.jsonl`
  and printed `codex resume f4e4a25a-9cc8-4174-a2f1-2c507271ff03`.

### Next Agent

- Add an interactive session picker for non-latest workflows.
- Consider a packaged `can-bridge` binary name instead of requiring
  `node dist\cli\index.js`.

## 2026-05-01 - Codex

### Status

Completed the alias/share design spec and `harness doctor` prototype.

### Changed

- Added `docs/ALIAS_SHARE_SPEC.md` covering short aliases, friend sharing,
  Gist vs hosted server vs IPFS, alias schema, CLI shape, expiry, auth, and
  encryption trade-offs.
- Added `src/doctor/session-doctor.ts` with Claude Code/Codex JSONL marker
  validation, compatibility score, status, and finding codes.
- Added `harness doctor --from <source> --session <id|path> [--json]`.
- Added doctor smoke tests to `tests/smoke.test.mjs`.
- Updated doctor to treat Claude `last-prompt`, `queue-operation`, and
  `system` wrapper lines as compatible ignored runtime records.
- Updated `README.md`, `TASK_CONTEXT.md`, `docs/OPEN_QUESTIONS.md`, and
  `docs/DECISIONS.md`.

### Verified

- `npm test`: 13/13 pass.
- `node dist\cli\index.js doctor --from codex --session 019de2a3-60af-7342-9052-cdf43ecca9a0`:
  ok, 100/100, 231/231 lines parsed.
- `node dist\cli\index.js doctor --from claude-code --session 8131efb2-19ac-407b-a538-8d94a94258e5`:
  ok, 100/100, 2563/2563 lines parsed.
- Latest Claude Code context extracts successfully: 409 normalized messages,
  source model `claude-opus-4-7`, cwd `C:\Users\ddoon\Desktop\context_switching`.

### Next Agent

- Decide whether `pipe` should call `doctor` by default before direct session
  injection, or expose it as `--doctor`.
- Alias/share implementation can start with the local registry commands:
  `keep`, `aliases`, `show`, and `forget`.

## 2026-04-30 - Codex

### Status

Completed a related-project scan and updated positioning docs.

### Changed

- Added `docs/RELATED_PROJECTS.md` with closest GitHub overlaps:
  `ai-session-bridge`, AgentBridge, Codex Bridge variants, ccb, HeyAgent,
  PAL MCP, CoBridge, RexCLI, codeplow, and context-file interop tools.
- Kept the README related-work section as a single pointer to
  `docs/RELATED_PROJECTS.md` and removed the duplicate inline list.
- Updated `README.md` test badge/verified-behavior text to 11/11.
- Updated `TASK_CONTEXT.md` to reflect branch handling, `[error] ` decode,
  and the current v1 queue.
- Added `D-0007` to `docs/DECISIONS.md`.

### Verified

- Searched GitHub and web results for Claude/Codex bridge, MCP wrapper,
  context handoff, and `AGENTS.md`/`CLAUDE.md` sync projects.
- Reviewed high-signal README pages for the projects captured in
  `docs/RELATED_PROJECTS.md`.
- `npm test`: 11/11 pass.

### Next Agent

- Keep positioning as "context interchange core" unless the code grows a real
  live bridge.
- If adding a live bridge, compare directly against AgentBridge and
  `codex-claude-bridge` first.
- If adding an MCP layer, compare directly against `codex-mcp-server`,
  `codex-bridge`, `codex-bridge-mcp`, and PAL MCP first.

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
