import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
function readVersion() {
    try {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const pkgPath = path.resolve(here, "..", "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (typeof pkg.version === "string" && pkg.version.length > 0) {
            return pkg.version;
        }
    }
    catch {
        // fall through
    }
    return "0.0.0";
}
export const HARNESS_VERSION = readVersion();
/**
 * Sentinel string identifying packages and session files produced by
 * can-bridge. Use anywhere the format expects a "tool/cli version" field
 * so that future debuggers can tell at a glance these are bridge-emitted.
 */
export const HARNESS_SENTINEL = `can-bridge-${HARNESS_VERSION}`;
//# sourceMappingURL=version.js.map