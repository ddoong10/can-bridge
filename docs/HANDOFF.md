# Handoff Log

Use this file to pass work between Claude Code, Codex, and other agents. New
entries go at the top.

## 2026-06-03 - Codex (optional context budgeting)

### Status

Adding opt-in context-budget controls for `.cbctx` packages so long sessions can
be shared/imported without changing the default fidelity-first behavior.

### Changed

- Added `--context-mode slim`, `--no-native`, `--since-compact`, and
  `--max-tool-output-chars` for `share`.
- Added the same budget controls for `.cbctx import`, so receivers can reduce an
  existing package before injection.
- Added a pure `transform/budget` layer that can drop native raw, trim to
  post-compaction context, and truncate large tool outputs.
- Added `.cbctx` `budget` metadata and documented the trade-off.

### Verification

- `npm test`: passed, **59/59** tests.

## 2026-06-03 - Claude Code (claude→claude native preservation + live signed-thinking test)

### Status

Made same-tool native preservation SYMMETRIC: added it to the Claude adapter
(already existed for Codex). Live-tested the open question — does a replayed
session with **signed** Claude thinking survive `claude --resume`? **It does.**

### Changed

- `adapters/claude-code.ts`: extract carries `raw: { tool, lines }`; inject
  replays via `buildClaudeFromRaw` when `raw.tool === "claude-code"` — every
  line byte-identical except `sessionId`/`cwd` (so `message`/`uuid`/signed
  thinking untouched), fresh fence root prepended.
- `.cbctx` path already generic (claude native artifact + restore reuse existing
  share/import; redactor already scrubs `raw.lines`).
- `tests/smoke.test.mjs`: +1 test (claude native replay preserves the thinking
  signature byte-for-byte).
- `docs/LIMITATIONS.md`: §1.6 + §C corrected — claude→claude native now
  preserves signed thinking; earlier "re-inject impossible" claim disproven.

### Verification

- Build clean, **56/56** pass. Claude session files DO store the 812-char
  thinking `signature`.
- Live: native-replayed a real thinking-bearing session, ran
  `claude --print --resume <id> --model sonnet "..."` → **exit 0, no signature
  rejection, correctly summarized the prior conversation.**
- Caveat: proves the replayed file resumes & recalls context with signatures
  intact; does not independently prove Claude re-validates ALL prior thinking
  each turn. Cross-tool still drops thinking by design.

### Note

- Live test session left at `~/.claude/projects/C--Users-ddoon-Desktop-context-switching/f2f2e8f3-4145-44e1-ad53-1eb98164ab23.jsonl` (reusable for a live demo; delete to clean up).

## 2026-06-03 - Codex (reasoning continuity wording)

### Status

Clarified the presentation and limitation wording around Codex reasoning,
`/resume`, and how much context can realistically be restored.

### Changed

- Updated `docs/FINAL_PRESENTATION_NOTES.md` with a presentation-ready
  distinction between recorded native reasoning artifacts and hidden model
  runtime state.
- Updated `docs/LIMITATIONS.md` to avoid the misleading blanket claim that all
  reasoning is unrecoverable: Codex recorded reasoning items can be preserved in
  same-tool native replay, while KV cache / hidden execution state still cannot.
- Added decision D-0010 in `docs/DECISIONS.md`: optimize for practical task
  continuity, not agent identity cloning.

### Verification

- Documentation-only change; no build/test run.

## 2026-06-03 - Codex (final presentation prep)

### Status

Preserved the original midterm `docs/PRESENTATION_NOTES.md` and added
`docs/FINAL_PRESENTATION_NOTES.md` for the final presentation narrative.

### Changed

- Restored `docs/PRESENTATION_NOTES.md` as the middle-presentation record.
- Added final-presentation notes focused on what changed after the midterm:
  bidirectional/tool-call-aware conversion, `.cbctx`, foreign-tool marking,
  repo-state verification, same-tool Codex native replay, limitations, and the
  Context Hub/provenance vision.
- Left behavior-evaluation details out of this note because another teammate is
  covering the evaluation section.
- Added a final slide outline and Q&A section.

### Verification

- Documentation-only change; no build/test run after this edit.
- Checked the final presentation notes for stale terms such as `harness`, old
  test counts, and already-resolved limitations.

## 2026-06-03 - Codex (native preservation review follow-up)

### Status

Kept the same-tool native artifact path fidelity-first, and added guardrails
that document the trade-off without weakening the preservation goal.

### Changed

- Added a cross-tool regression test: `.cbctx` packages may contain Codex native
  artifacts, but importing the package into Claude Code uses the normalized
  transcript and does not leak Codex-native reasoning lines.
- Clarified `buildCodexFromRaw()` as an intentional fidelity-first replay path:
  only `session_meta` is replaced; other raw Codex lines are preserved for
  same-tool recall quality.
- Updated `docs/LIMITATIONS.md` and `docs/TECH_DEBT.md` to state that native
  artifacts prioritize same-tool fidelity now, while stronger hash anchoring /
  signatures are future Context Hub hardening work.

### Verification

- `npm test`: passed, **55/55** tests.

## 2026-06-03 - Claude Code (same-tool native preservation in .cbctx)

### Status

Implemented the Codex-authored spec: preserve the verbatim native session so a
SAME-tool round-trip (codex→codex, incl. via `.cbctx`) restores far more than the
normalized schema allows. Cross-tool still uses NormalizedContext. NON-GOAL
(unchanged): KV cache / hidden reasoning state / server state are not replicated.

### Changed

- `schema/context.ts`: `NormalizedContext.raw?: RawSession { tool, lines }`.
- `adapters/codex.ts`: extract carries `raw` (verbatim rollout); inject replays
  it via `buildCodexFromRaw` when `raw.tool === "codex"` (fresh session_meta +
  fence, drops the source's session_meta, keeps reasoning/turn_context/events).
- `schema/cbctx.ts`: `CbctxPackage.native?: CbctxNativeArtifact[]`
  ({tool, format, capturedAt, sessionId, contentHash, content}) +
  `computeNativeContentHash`.
- `share/share.ts`: `buildPackage` emits a native artifact from `working.raw`
  (already thinking-stripped + redacted upstream).
- `share/import.ts`: `packageToContext` restores `raw` from `native[]` only when
  tool matches AND the artifact hash verifies (untrusted ⇒ else fall back to
  normalized). Import already rewrites cwd→receiver; inject already mints a new
  session id.
- `transform/redactor.ts`: redacts `raw.lines` too (so `--redact` covers native).
- `tests/smoke.test.mjs`: +6 tests (native replay; cbctx native present;
  import-uses-native w/ new id + receiver cwd; tampered native ignored; no-native
  fallback; redacted native has no secret).

### Verification

- Build clean, **54/54** smoke tests pass.
- Live e2e: codex rollout → .cbctx (native, reasoning kept) → import → codex
  inject preserves reasoning/turn_context, fresh id, receiver cwd; `--redact`
  scrubs secrets inside native; tampered native falls back.

### Pending

- Diff sent to Codex(gpt-5.5) for review (per the agreed flow). Apply findings
  before final. Follow-ups: claude→claude native artifact (symmetric); a
  `--preserve-session-id` flag; doctor check for native format drift.

## 2026-06-03 - Claude Code (repo-state verification, #3)

### Status

Implemented Codex-recommended #3: capture the source workspace's git state on
extract, embed it in the Codex import preamble, and warn when the target
workspace has moved since capture. We transfer a transcript, never the files —
this makes stale-state mismatches visible instead of silent.

### Changed

- `src/schema/context.ts`: `SourceInfo.git?: GitState { branch, commit, dirty }`.
- `src/util/git.ts` (new): `captureGitState(cwd)` (best-effort, bounded timeout,
  null when not a git work tree / git absent), `formatGitState`,
  `gitMismatchWarning(source, current)`.
- `claude-code.ts` / `codex.ts` extract: populate `source.git` from the source
  cwd at export time.
- `codex.ts` inject: base_instructions now include "Source workspace" + "Source
  git state at capture"; inject probes the *current* target cwd and prepends
  `⚠️ Workspace moved since capture …` to the hint when commit/branch differ
  (also surfaced as `details.gitMismatch`).
- `tests/smoke.test.mjs`: +2 tests (mismatch logic; inject snapshot).

### Verification

- Build clean, **48/48** smoke tests pass.
- Live: `captureGitState(repo)` → `main @ 5f4c76a (dirty)`; mismatch vs an old
  commit warns.

### Codex review (gpt-5.5) — all 5 findings applied

- [HIGH] mismatch warning now also embedded in `base_instructions` (not just the
  hint), so the resumed agent sees it.
- [HIGH] dirty-flag change now triggers a warning (not only commit/branch).
- [MED] "could not verify" warning when source had git state but the target
  can't be read (no longer looks like a safe match).
- [MED] no longer runs git against the transcript-provided `cwd`; both extract
  and inject probe `process.cwd()` only, plus `core.fsmonitor=`/`GIT_OPTIONAL_LOCKS=0`
  hardening against config-triggered execution.
- [MED] detached HEAD handled via `git branch --show-current`; commit is the
  primary mismatch signal so a branch-only difference at the same commit no
  longer false-positives.

Re-verified: build clean, 48/48 pass; live inject embeds the warning in both
base_instructions and the hint.

## 2026-06-03 - Claude Code (context-preservation pass)

### Status

Implemented the two highest-impact context-preservation improvements (Codex-
reviewed): foreign-tool marking + stronger import preamble. Target: stop the
resumed Codex agent from mistaking Claude's tool history for its own callable
tools.

### Changed (`src/adapters/codex.ts`)

- **Foreign-tool marking**: tool_use names from a non-Codex source are emitted
  as `foreign_tool:<source>:<name>` (e.g. `foreign_tool:claude-code:Read`)
  instead of a bare native `function_call` name. `markForeignToolName` /
  `unmarkForeignToolName`; extract strips the prefix so Norm→Codex→Norm is
  lossless and re-injection is idempotent. Codex-native sources are left as-is.
- **Preamble** (`buildBaseInstructions`): for non-Codex sources, adds explicit
  continuation guidance — tool calls are historical evidence, source tool names
  don't exist here (map intent to your own tools), re-verify files/git state
  before editing.
- `tests/smoke.test.mjs`: +2 tests (foreign marking + round-trip; native source
  not marked).

### Verification

- Build clean, **46/46** smoke tests pass.
- Live claude→codex conversion (into a temp `CB_CODEX_HOME`): every tool name
  marked (`foreign_tool:claude-code:{Read,Bash,Edit,Grep,Glob,Write,mcp__*,…}`),
  all three preamble guidance lines present.

### Remaining (LIMITATIONS §2.1)

- Marking/preamble prevent *misidentification* only; they cannot make past calls
  re-executable. Semantic mapping (`Bash↔shell_command`) unimplemented;
  `TodoWrite`/`Task`/MCP have no target equivalent.
- Symmetric foreign-tool marking on the **Claude inject** side (codex→claude:
  Claude sees `shell_command`) is not done yet — consider next.

## 2026-06-03 - Claude Code (test isolation)

P0-1 fixed: adapters/doctor resolve the session store from `CB_CLAUDE_HOME` /
`CB_CODEX_HOME` at call time; smoke suite points both at a throwaway `mkdtemp`
home so `inject()` never writes to the real `~/.claude` / `~/.codex`. The
"ambiguous id" test no longer writes fixtures into the real projects dir.
Design reviewed by Codex(gpt-5.5). 44/44 → (now 46/46) pass. Commit `14b581e`.

## 2026-06-03 - Claude Code

### Status

Limitations analysis (`docs/LIMITATIONS.md`) + fixed 3 inject-side fidelity
defects it surfaced. Cross-checked with Codex(gpt-5.5) as the target agent.

### Changed

- Added `docs/LIMITATIONS.md`: extraction vs injection vs fundamental limits,
  per-direction extraction loss (loss is a function of SOURCE only;
  claude→claude / codex→codex are also lossy via the normalized bottleneck),
  and an evidence-based "why not extract all lines" section (194KB of dropped
  bytes are hook/scaffolding noise; only `hook_additional_context` is worth
  selectively recovering).
- `src/adapters/codex.ts` `messageToResponseItems()` rewritten:
  - **Block order preserved** (was: all text → all tool_use → all tool_result;
    now: original interleaved order, consecutive text coalesced).
  - **Dangling tool_use repaired**: `buildCodexJsonl` precomputes the set of all
    tool_result ids; a tool_use with no matching result gets a synthetic
    placeholder `function_call_output` so every call is paired.
  - **No empty call_id**: tool_result without toolUseId now gets a synthetic id.
- `tests/smoke.test.mjs`: +2 regression tests (dangling repair, interleaved
  order).

### Verification

- `npm run build`: clean.
- `node --test tests/smoke.test.mjs`: **44/44 pass**.
- Live re-conversion of a real Claude session: function_call vs output
  **dangling 6 → 0** (6 synthetic outputs), empty call_id 0.

### Notes / Remaining (from LIMITATIONS §4.5)

- Tier-B (mitigable, unimplemented): foreign-tool namespacing (2.1),
  selective `hook_additional_context` recovery (1.1), CLAUDE.md/AGENTS.md
  embedding (1.2), cwd/branch/commit capture + mismatch warning (2.7).
- Tier-C (impossible): behavioral equivalence, thinking/reasoning recovery,
  pre-compacted source originals, cache benefit, zero injection risk.
- `[error]` prefix ambiguity (2.5) and `toolu_` call_id provenance (2.4) left
  as-is intentionally (low value / round-trip risk).

## 2026-05-25 - Codex

### Status

Fixed the live Windows Codex eval path after testing showed prompt argv
splitting, stdin hangs, read-only Codex sandboxing, and missing untracked files
in captured diffs.

### Changed

- Default Codex eval commands now pass the prompt through stdin instead of argv.
- Eval command spawning explicitly closes child stdin after writing the prompt.
- Default Codex eval commands include `--sandbox workspace-write` so coding
  tasks can modify files inside the eval workspace.
- `diff.patch` now includes untracked files from
  `git ls-files --others --exclude-standard`, so newly added fixtures count for
  `mustModify` checks.

### Verification

- `npm.cmd run build`: passed.
- Live eval in `C:\tmp\can-bridge-evals\stdin-live-check-run`: Codex exited
  0 with prompt read from stdin.
- Live eval in `C:\tmp\can-bridge-evals\stdin-workspace-check-run`: Codex ran
  with `sandbox: workspace-write`.
- Live eval in `C:\tmp\can-bridge-evals\stdin-untracked-check-run`: final
  score `100.0 (valid)`, including `mustModify:tests/evals/fixtures`.
- `node --test tests\smoke.test.mjs --test-name-pattern eval`: eval tests
  passed, but this Node invocation still ran the whole file and the known
  inject-style tests failed under sandbox EPERM when writing to
  `C:\Users\sg682\.claude` / `.codex`.

## 2026-05-25 - Codex

### Status

Added visible progress artifacts for long `can-bridge eval run` executions.

### Changed

- `eval run` now creates `status.json` immediately after loading the case.
- Agent and git-diff stdout/stderr stream to files while commands run instead
  of being written only after process exit.
- `commands.jsonl` now records a `status:"started"` entry before each command
  plus the finished command record after exit.
- Console output now shows coarse `[1/5]` through `[5/5]` progress.
- Scoring ignores `commands.jsonl` started records and uses finished command
  records for validity and command matching.
- Documented how to inspect `status.json` and `*.agent.stderr.txt -Wait`.

### Verification

- `npm.cmd run build`: passed.
- `eval run --command "node --version"` prints progress, creates
  `status.json`, streams stdout/stderr files, and scores as `Valid: yes`.

## 2026-05-25 - Codex

### Status

Fixed Windows eval command execution after live testing showed `codex` could be
found in PowerShell but failed under Node `spawn`, and failed agent commands
were still being scored as if the run were valid.

### Changed

- Default eval commands now use `codex.cmd` / `claude.cmd` on Windows.
- `.cmd` and `.bat` commands are launched through `cmd.exe /d /s /c` with
  argument quoting so npm shims work from Node.
- Custom command templates now preserve `{{prompt}}` as one argv item instead
  of splitting it on spaces.
- Eval scores now include `valid` / `invalidReason`; failed or missing agent
  commands set `Task Success` and final score to `0.0`.
- Added smoke coverage for prompt argv preservation and invalid agent-command
  scoring.

### Verification

- `npm.cmd run build`: passed.
- Eval-specific smoke tests passed; full `node --test tests\smoke.test.mjs`
  still hits the known sandbox limitation where inject-style tests cannot write
  to `C:\Users\sg682\.claude` / `.codex`.
- Re-scored a previously failed Windows run: output now reports `Valid: no`,
  `Invalid Reason: agent command failed with exitCode 2`, and `Final Score:
  0.0`.
- `eval run --command "node --version"` creates a valid smoke run and
  `eval score` reports `Valid: yes`.

## 2026-05-25 - Codex

### Status

Adjusted the eval scoring model after the first live smoke comparison showed
Converted scoring below No Context solely because of token-efficiency penalty.

### Changed

- Default eval final score now excludes token efficiency; it remains reported
  as a diagnostic.
- Updated docs to explain that token efficiency is opt-in for compression
  experiments.
- Added `can-bridge-session-gotcha.json`, a stronger fixture designed to catch
  JSON-vs-YAML and no-runtime-dependency context loss.

### Verification

- `npm.cmd run build`: passed.
- Re-scored the live No Context smoke run with the updated default weights:
  final score changed from 77.5 to 75.0.
- Re-scored the live Converted smoke run with the updated default weights:
  final score changed from 67.5 to 75.0. Token efficiency still reports 0.0,
  but it no longer lowers the default behavior score.

## 2026-05-25 - Codex

### Status

Added the first fully automatic behavior-evaluation MVP.

### Changed

- Added `src/eval/` with case loading, automatic run capture, and deterministic
  scoring.
- Added `can-bridge eval run` to execute Codex or Claude Code non-interactively,
  optionally converting a source session into the target first.
- Added `can-bridge eval score` to score existing run artifacts.
- Added evaluation docs and sample JSON cases under `tests/evals/fixtures/`.
- Ignored generated `runs/` artifacts in git.
- Recorded D-0009: evaluate context transfer by agent behavior.

### Notes

- Eval cases are JSON for now to avoid adding a YAML dependency.
- `eval run --condition converted --source <tool> --source-session <id|latest>
  --agent <target>` performs source extraction, target injection, agent run,
  artifact capture, and scoring.
- Default agent commands are `codex exec --skip-git-repo-check ...` and
  `claude --print ...`; custom commands can use `{{prompt}}` and
  `{{sessionId}}`.

### Verification

- `npm.cmd run build`: passed.
- `node dist\cli\index.js eval help`: prints the new eval help.
- `node dist\cli\index.js eval run --case tests\evals\fixtures\can-bridge-continuation.json --condition no-context --agent codex --out runs\eval-smoke --command "node --version"`:
  created run artifacts and `score.json`.
- `node dist\cli\index.js eval score --case tests\evals\fixtures\can-bridge-continuation.json --run runs\eval-smoke`:
  scored the smoke run.
- `npm.cmd test`: build passed, then 25/39 tests passed and 14 failed because
  the sandbox blocks writes to `C:\Users\sg682\.claude` and
  `C:\Users\sg682\.codex`. The failures are the existing inject-style tests
  that write real agent session files.

## 2026-05-02 - Codex

### Status

Tightened `list` again after checking duplicate-looking Codex sessions from
2026-04-30.

### Findings

- `17a9309c-ca93-446a-ba1f-ba89113f5f3c`,
  `90bc1970-8bcd-4d09-9f1e-57f299012cd2`, and
  `298ef083-19f5-4241-94de-b5b5605ff515` all came from the same original
  Claude Code session: `8131efb2-19ac-407b-a538-8d94a94258e5`.
- They were created by the early `llm-context-harness` import path
  (`originator: llm-context-harness`, `source: harness-import`).
- They are not identical: message counts are 82, 83, and 84. The latest user
  prompt is the same, but the latest assistant progress differs.

### Changed

- Codex `list` now parses import lineage from `base_instructions`.
- `list` now shows `imported from <tool>:<original-session-prefix>`.
- `list` now shows `latest assistant` preview in addition to `latest user`.
- `list` now shows origin metadata when available.

### Verified

- `npm test`: 39/39 pass.
- `node dist\cli\index.js list --from codex --all` now distinguishes the three
  2026-04-30 sessions by latest assistant preview and shared origin.

## 2026-05-02 - Codex

### Status

Improved session selection UX so users are not forced to identify chats by
random UUID alone.

### Changed

- `list` now shows newest sessions first.
- Each listed session can include message count, model, project name, cwd, and
  latest meaningful user-message preview.
- Added `list --cwd` to filter to the current working directory.
- Added `list --limit <n>`, `list --all`, and `list --json`.
- Updated README quick-start examples to prefer `list --cwd --limit 10`.

### Verified

- `npm test`: 39/39 pass.
- `node dist\cli\index.js list --from codex --cwd --limit 5` identifies the
  current conversation by the latest user message.

## 2026-05-02 - Codex

### Status

Published `can-bridge@0.2.0` to npm and updated install docs.

### Changed

- `npm view can-bridge version` now resolves to `0.2.0`.
- README install instructions now lead with `npm install -g can-bridge`.
- Roadmap install/share examples now use the npm package as the default path.
- GitHub tarball install remains documented for unreleased `main` commits.

### Verified

- npm registry lookup: `can-bridge@0.2.0`.
- `git status --short`: clean before doc updates.

## 2026-05-02 - Codex

### Status

Added a roadmap document for the current project state and next plan.

### Changed

- Added `docs/ROADMAP.md`.
- Captures completed work, positioning, near-term priorities, security/fidelity
  follow-ups, collaboration direction, install command, and current share flow.

## 2026-05-02 - Codex

### Status

Reviewed and tightened the Architect-approved security hardening patch before
push.

### Changed

- Read `docs/REVIEW_2026-05-02.md` and verified the implemented P0/P1/HIGH
  items against the code.
- Fixed a regression in `buildPackage`: `--redact` was applying redaction to
  the original context after thinking blocks had been stripped, which could
  revive thinking blocks inside `.cbctx`. Redaction now runs on the
  already-stripped context.
- Tightened `.cbctx` integrity verification: packages missing `contentHash`
  now fail by default. `--skip-hash-verify` is required for trusted legacy
  packages or intentional overrides.
- Added regression coverage for both cases above.
- Updated README to document that missing hashes are rejected by default and
  to reflect the current test count.

### Verified

- `npm test`: 37/37 pass.
- `npm pack --dry-run`: package builds with 58 files and includes new
  `dist/transform/fence.*` and `dist/version.*` artifacts.
- `git diff --check`: no whitespace errors (only CRLF conversion warnings).
- `node dist\cli\index.js --help`: current local CLI shows
  `--skip-hash-verify`.

## 2026-05-02 - Codex

### Status

Confirmed shared handoff docs are updated for Claude Code, and reconciled them
with the latest `can-bridge`-only CLI naming.

### Notes For Claude Code

- The public/global install work is documented immediately below in the
  2026-05-01 Codex entry.
- A later commit `124f591` removed the legacy `harness` bin and user-facing
  identifiers. The package now exposes only:
  `can-bridge -> ./dist/cli/index.js`.
- Historical handoff entries may still mention `harness`; treat those as
  historical command names from the time of each entry, not current UX.
- Current install command verified earlier:
  `npm install -g https://github.com/ddoong10/can-bridge/archive/refs/heads/main.tar.gz`.
- Current repo visibility is public, so unauthenticated friends can install.

### Verified

- `git status --short`: clean before this note.
- Latest commit before this note: `124f591 Drop legacy harness bin and
  identifiers — can-bridge only`.

## 2026-05-01 - Codex

### Status

Prepared public/global install UX for `can-bridge`.

### Changed

- Bumped package metadata to `can-bridge@0.2.0`.
- Added official npm bin `can-bridge`, keeping `harness` as a legacy alias.
- Committed built `dist` artifacts and removed `prepare` so GitHub installs do
  not require TypeScript at install time.
- The repo was switched from PRIVATE to PUBLIC so unauthenticated friends can
  install it.
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
- First GitHub install attempt failed while `prepare` tried to run `tsc`; fixed
  by committing `dist` and removing `prepare`.
- Verified public install command:
  `npm install -g https://github.com/ddoong10/can-bridge/archive/refs/heads/main.tar.gz`.

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
