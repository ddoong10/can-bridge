import type { NormalizedContext } from "../schema/context.js";
export declare function redactText(input: string): string;
/** Returns a deep-copied, redacted clone — does not mutate the input. */
export declare function redactContext(ctx: NormalizedContext): NormalizedContext;
