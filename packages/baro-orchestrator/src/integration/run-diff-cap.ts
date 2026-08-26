import { Buffer } from "node:buffer"

/** Max bytes of aggregate run diff text carried in the run-level story_diff event. */
export const MAX_RUN_DIFF_BYTES = 256 * 1024

/**
 * Caps the aggregate run diff so an oversized payload cannot stall the stdout
 * pipe and cost the following `done` event. Cutting on a newline keeps the
 * marker on its own line and can never split a multi-byte character.
 * Under-cap input is returned unchanged, byte for byte.
 */
export function capRunDiff(diff: string | undefined): string | undefined {
    if (diff === undefined || diff === "") return diff
    const buf = Buffer.from(diff, "utf8")
    if (buf.byteLength <= MAX_RUN_DIFF_BYTES) return diff

    const head = buf.subarray(0, MAX_RUN_DIFF_BYTES)
    const cut = head.lastIndexOf(0x0a)
    const kept = cut < 0 ? "" : head.subarray(0, cut + 1).toString("utf8")
    const keptBytes = cut < 0 ? 0 : cut + 1
    const omitted = buf.byteLength - keptBytes
    return kept + `… (run diff truncated: ${omitted} bytes omitted)`
}
