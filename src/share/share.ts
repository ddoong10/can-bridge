import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NormalizedContext } from "../schema/context.js";
import type {
  CbctxPackage,
  CbctxRedactionInfo,
  CbctxRepoRef,
  CbctxDoctorSnapshot,
} from "../schema/cbctx.js";
import { CBCTX_SCHEMA_V1, computeCbctxContentHash } from "../schema/cbctx.js";
import { redactContext } from "../transform/redactor.js";
import { diagnoseSessionFromContext } from "../doctor/session-doctor.js";
import { HARNESS_VERSION } from "../version.js";

const execFileAsync = promisify(execFile);

export interface BuildPackageOptions {
  redact?: boolean;
  includeRepoRef?: boolean;
  includePatch?: boolean;
  /** Working directory to inspect for git metadata. Defaults to source.cwd. */
  repoCwd?: string;
}

export interface BuildPackageResult {
  pkg: CbctxPackage;
  redaction: CbctxRedactionInfo;
}

/**
 * Pure(ish) builder: takes an extracted NormalizedContext and produces a
 * CbctxPackage. The only I/O it does is shelling out to `git` when
 * includeRepoRef/includePatch are set; that is opt-in.
 */
export async function buildPackage(
  ctx: NormalizedContext,
  opts: BuildPackageOptions = {},
): Promise<BuildPackageResult> {
  // Strip thinking blocks before any further processing. They are
  // signed artifacts of the source model and the README promises they
  // are dropped on cross-tool transfer; including them in a shared
  // package leaks them to receivers and lets a malicious sender hand-craft
  // arbitrary "thinking" payloads that bypass the recipient's reasoning.
  let working = stripThinkingBlocks(ctx);
  let redaction: CbctxRedactionInfo = { enabled: false, findings: [] };

  if (opts.redact) {
    const before = countSecretCandidates(working);
    working = redactContext(working);
    const after = countSecretCandidates(working);
    redaction = {
      enabled: true,
      findings: diffFindings(before, after),
    };
  }

  let repo: CbctxRepoRef | undefined;
  if (opts.includeRepoRef || opts.includePatch) {
    const cwd = opts.repoCwd ?? working.source.cwd;
    if (cwd) {
      repo = await collectRepoRef(cwd, opts.includePatch === true);
    }
  }

  const doctor: CbctxDoctorSnapshot | undefined = await snapshotDoctor(
    working,
  );

  const source = {
    tool: working.source.tool,
    sessionId: working.source.sessionId,
    cwd: working.source.cwd,
    capturedAt: working.source.capturedAt,
    model: working.source.model,
  };
  const contentHash = computeCbctxContentHash({
    source,
    summary: working.summary,
    messages: working.messages,
  });
  const pkg: CbctxPackage = {
    schema: CBCTX_SCHEMA_V1,
    source,
    ...(repo ? { repo } : {}),
    ...(working.summary ? { summary: working.summary } : {}),
    messages: working.messages,
    redaction,
    ...(doctor ? { doctor } : {}),
    createdAt: new Date().toISOString(),
    harnessVersion: HARNESS_VERSION,
    contentHash,
  };
  return { pkg, redaction };
}

/**
 * Write a CbctxPackage to disk. Returns the absolute path written.
 * If outPath is "-" the JSON is written to stdout and the empty string is
 * returned.
 */
export async function writePackage(
  pkg: CbctxPackage,
  outPath: string,
): Promise<string> {
  const json = JSON.stringify(pkg, null, 2);
  if (outPath === "-" || outPath === "/dev/stdout") {
    process.stdout.write(json + "\n");
    return "";
  }
  const abs = path.resolve(outPath);
  await fs.writeFile(abs, json + "\n", "utf8");
  return abs;
}

/** Default file name based on session id and date. */
export function defaultPackageName(sessionId: string | undefined): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const id = sessionId ? sessionId.slice(0, 8) : "session";
  return `can-bridge-${id}-${stamp}.cbctx`;
}

// ─── helpers ─────────────────────────────────────────────────────────

async function collectRepoRef(
  cwd: string,
  includePatch: boolean,
): Promise<CbctxRepoRef | undefined> {
  const repo: CbctxRepoRef = { dirtyPatchIncluded: false };
  const tryGit = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd });
      return stdout.trim();
    } catch {
      return null;
    }
  };

  const inside = await tryGit(["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") return undefined;

  const remote = await tryGit(["remote", "get-url", "origin"]);
  if (remote) repo.remote = remote;
  const branch = await tryGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch) repo.branch = branch;
  const commit = await tryGit(["rev-parse", "HEAD"]);
  if (commit) repo.commit = commit;

  if (includePatch) {
    const patch = await tryGit(["diff", "--no-color"]);
    if (patch && patch.length > 0) {
      repo.patch = patch;
      repo.dirtyPatchIncluded = true;
    }
  }
  return repo;
}

async function snapshotDoctor(
  ctx: NormalizedContext,
): Promise<CbctxDoctorSnapshot | undefined> {
  try {
    const r = await diagnoseSessionFromContext(ctx);
    return {
      status: r.status,
      score: r.score,
      findings: r.findings.map((f) => ({
        level: f.level,
        code: f.code,
        message: f.message,
      })),
    };
  } catch {
    // doctor is best-effort; do not block share if it can't run.
    return undefined;
  }
}

/**
 * Heuristic count of plausible secret tokens BEFORE redaction, so we can
 * report a per-kind diff after redaction. We re-use the same patterns as
 * the redactor by counting [REDACTED:<kind>] markers in the redacted text.
 */
function countSecretCandidates(ctx: NormalizedContext): Map<string, number> {
  const counts = new Map<string, number>();
  const all = serialize(ctx);
  for (const m of all.matchAll(/\[REDACTED:([^\]]+)\]/g)) {
    const kind = m[1];
    if (!kind) continue;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return counts;
}

function diffFindings(
  before: Map<string, number>,
  after: Map<string, number>,
): Array<{ kind: string; count: number }> {
  // Findings are the markers present AFTER redaction (= what was masked).
  const out: Array<{ kind: string; count: number }> = [];
  const seen = new Set<string>();
  for (const [kind, count] of after) {
    const delta = count - (before.get(kind) ?? 0);
    if (delta > 0) out.push({ kind, count: delta });
    seen.add(kind);
  }
  out.sort((a, b) => a.kind.localeCompare(b.kind));
  return out;
}

function stripThinkingBlocks(ctx: NormalizedContext): NormalizedContext {
  let touched = false;
  const messages = ctx.messages.map((m) => {
    const filtered = m.content.filter((b) => b.type !== "thinking");
    if (filtered.length !== m.content.length) touched = true;
    return filtered === m.content ? m : { ...m, content: filtered };
  });
  return touched ? { ...ctx, messages } : ctx;
}

function serialize(ctx: NormalizedContext): string {
  const parts: string[] = [];
  if (ctx.summary) parts.push(ctx.summary);
  for (const m of ctx.messages) {
    for (const b of m.content) {
      if (b.type === "text" || b.type === "thinking") parts.push(b.text);
      else if (b.type === "tool_result") parts.push(b.output);
      else if (b.type === "tool_use") parts.push(JSON.stringify(b.input));
    }
  }
  return parts.join("\n");
}
