import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Run a Critic CLI in a fresh, otherwise-empty directory and remove it after
 * the process has fully settled. Critic prompts contain untrusted repository
 * evidence, so they must never inherit Baro's own working directory.
 */
export async function withIsolatedCriticCwd<T>(
    run: (cwd: string) => Promise<T>,
): Promise<T> {
    const cwd = await mkdtemp(join(tmpdir(), "baro-critic-"))
    try {
        return await run(cwd)
    } finally {
        await rm(cwd, { recursive: true, force: true })
    }
}
