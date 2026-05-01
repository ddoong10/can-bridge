/**
 * Untrusted-content isolation header.
 *
 * Cross-tool context transfer is a prompt-injection vector: the imported
 * conversation may contain text that *looks* like a system instruction
 * ("ignore previous", "you are now ..."). We prepend this fence to every
 * inject path so the resuming agent treats the transcript as data, not
 * commands.
 *
 * Wording is deliberately defensive but short — long fences burn context
 * tokens. Keep this under ~80 words.
 */
export declare const UNTRUSTED_FENCE_HEADER: string;
/** Stable opening token used to detect a fence we (or another bridge) wrote. */
export declare const FENCE_MARKER = "[can-bridge: imported context follows]";
/**
 * Remove every leading fence header we may have authored. Loops until
 * the text no longer starts with a marker so nested or doubled fences
 * (a contrived attacker payload, or an accidental double-wrap) cannot
 * survive round-trips.
 *
 * Only the canonical UNTRUSTED_FENCE_HEADER is stripped — we never
 * heuristically drop "the first paragraph", which would be a content
 * loss vector for adversarial inputs that start with the marker but
 * follow with real text.
 */
export declare function stripFence(text: string): string;
