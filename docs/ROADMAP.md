# can-bridge Roadmap

Updated: 2026-05-02

## Current State

`can-bridge` is a portable context handoff tool for Claude Code and Codex CLI.
It is not positioned as a live multi-agent router. The core value is:

```text
Move a coding-agent conversation into a portable package, then recreate a
resumable session for another person or another tool.
```

## Completed

- Claude Code -> Codex conversion.
- Codex -> Claude Code conversion.
- Live local resume verification in both directions:
  - `codex resume`
  - `claude --resume`
- `.cbctx` portable context package.
- Receiver-side cwd re-bucketing on `.cbctx` import.
- Public npm install path:

```powershell
npm install -g can-bridge
```

- GitHub main install path remains available for testing unreleased commits.
- `can-bridge` as the single public CLI name.
- Legacy `harness` user-facing commands removed.
- `.cbctx` `contentHash` integrity check.
- Import rejects missing or mismatched hashes by default.
- `--skip-hash-verify` override for trusted legacy or emergency imports.
- Untrusted-content fence on injected context.
- Thinking blocks stripped from shared packages and target inject paths.
- Schema doctor.
- Redaction.
- Local mailbox.
- `continue --latest`.
- Architect review captured in `docs/REVIEW_2026-05-02.md`.
- Test suite at `37/37 pass`.

## Positioning

`can-bridge` should be described as:

> A portable, resumable handoff layer for Claude Code and Codex CLI sessions.

Avoid positioning it as:

- A live agent router.
- A complete session backup format.
- A replacement for Claude Code or Codex memory.
- A guarantee of perfect vendor-internal state preservation.

The project is strongest where users need to hand work to:

- A teammate.
- Another machine.
- Another coding agent tool.
- The same tool in a different workspace.

## Near-Term Plan

### P0: v0.2 Stabilization

1. Create a GitHub release.
   - Tag: `v0.2.0`
   - Include release notes for:
     - verified bidirectional resume
     - `.cbctx`
     - receiver cwd re-bucketing
     - hash verification
     - untrusted-content fence
     - thinking strip

2. Add GitHub Actions CI.
   - Run `npm test` on push and pull request.
   - Verify TypeScript build.
   - Keep Node version aligned with `package.json` engines.

3. Rework README around the main user story.
   - Lead with "share a session with a friend".
   - Move raw export/import to advanced/debug.
   - Keep loss boundaries explicit.

### P1: Share UX

1. Make the recommended share command prominent:

```powershell
can-bridge share --from claude-code --latest --redact --include-repo-ref --include-patch --out handoff.cbctx
```

2. Improve import output.
   - Show the exact next resume command.
   - Show source tool/model/session.
   - Show repo branch/commit.
   - Warn when receiver repo state does not match package repo metadata.

3. Add an interactive picker.

```powershell
can-bridge share --from claude-code --pick
can-bridge continue --from codex --to claude-code --pick
```

4. Add friend-facing import guide.
   - "Install can-bridge"
   - "Clone or open the same repo"
   - "cd into the repo"
   - "import the `.cbctx`"
   - "run printed resume command"

### P2: Security And Trust

1. Add size limits.
   - Max package bytes.
   - Max messages.
   - Clear override flag.

2. Add signed packages.
   - Detached signature or embedded signature.
   - Hash proves integrity, but signature proves who produced it.

3. Add encrypted sharing.

```powershell
can-bridge share --from claude-code --latest --encrypt passphrase
```

4. Improve redaction reporting.
   - Make redaction findings easier to audit.
   - Consider default-on redaction for `share`.

### P3: Fidelity

1. Attachments, images, and file resources.
   - Preserve file references where possible.
   - Copy/embed when safe and explicitly requested.

2. Branch-aware Claude sessions.

```powershell
can-bridge share --from claude-code --session <id> --all-branches
```

3. Patch apply workflow.
   - If `.cbctx` includes a dirty patch, give receiver an apply command.

```powershell
can-bridge apply-patch handoff.cbctx
```

4. Better context summaries for very large sessions.
   - Target-aware trimming.
   - Optional generated summary.
   - Never silently truncate without reporting it.

### P4: Collaboration

1. Improve mailbox.
   - `mailbox watch`
   - thread summaries
   - clearer sender/recipient conventions

2. Explore MCP/daemon mode.
   - One agent asks another for a focused task.
   - Exchange task, file list, diff, and result.
   - Avoid sharing full context continuously.

3. Connect mailbox and `.cbctx`.
   - Mailbox for short live messages.
   - `.cbctx` for deep handoff.

## Recommended Next Three Tasks

1. Create `v0.2.0` GitHub release.
2. Add GitHub Actions CI.
3. Rewrite README around the friend-sharing flow.

After those, implement:

4. Session picker.
5. Package size/message limits.
6. Repo state mismatch warning on import.

## Current Install Command

```powershell
npm install -g can-bridge
can-bridge --help
```

For unreleased commits on `main`:

```powershell
npm install -g https://github.com/ddoong10/can-bridge/archive/refs/heads/main.tar.gz
```

## Current Share Flow

Sender:

```powershell
cd <project>
can-bridge share --from claude-code --latest --redact --include-repo-ref --include-patch --out handoff.cbctx
```

Receiver:

```powershell
npm install -g can-bridge
cd <project>
can-bridge import --to claude-code --in <path-to>\handoff.cbctx
claude --resume <printed-session-id>
```

Or:

```powershell
cd <project>
can-bridge import --to codex --in <path-to>\handoff.cbctx
codex resume <printed-session-id>
```
