import type { NormalizedContext } from "../schema/context.js";

export interface SourceAdapter {
  readonly id: string;
  extract(locator: string): Promise<NormalizedContext>;
  listSessions?(): Promise<SessionSummary[]>;
}

export interface TargetAdapter {
  readonly id: string;
  inject(context: NormalizedContext): Promise<InjectionResult>;
}

export interface SessionSummary {
  id: string;
  title?: string;
  updatedAt?: string;
  messageCount?: number;
  model?: string;
  cwd?: string;
}

export interface InjectionResult {
  /** Where the data was written, or what id was created. */
  locator: string;
  /** A human-readable next step, e.g. "Run: codex resume abc123". */
  hint: string;
  details?: Record<string, unknown>;
}
