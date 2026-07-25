import {
    closeSync,
    lstatSync,
    openSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, join } from "node:path"

/**
 * Linux procfs supplies a boot-tick identity. Portable POSIX `ps lstart` is
 * only second-resolution (not a Darwin kernel-unique process identifier), so
 * the macOS fallback remains a best-effort safety boundary and keeps its
 * validate-to-signal window deliberately short.
 */
export type ProviderIdentitySource =
    | "linux-proc-stat-v1"
    | "posix-ps-lstart-v1"

export interface ProviderOwnershipMember {
    pid: number
    startTime: string
}

export interface ProviderOwnershipGroup {
    processGroupId: number
    identitySource: ProviderIdentitySource
    members: ProviderOwnershipMember[]
}

interface ProviderOwnershipManifestConfig {
    path: string
    runToken: string
    generation: number
}

export type ProviderOwnershipPublishResult =
    | { ok: true; generation: number }
    | { ok: false; error: string }

const SCHEMA_VERSION = 1
const MAX_GROUPS = 512
export const MAX_PROVIDER_OWNERSHIP_MEMBERS_PER_GROUP = 16
const MAX_BOOTSTRAP_BYTES = 2 * 1024 * 1024

let config: ProviderOwnershipManifestConfig | null = null

export function providerOwnershipManifestConfigured(): boolean {
    return config !== null
}

/** Bind the process registry to the private file created by the Rust host. */
export function configureProviderOwnershipManifest(
    path: string,
    runToken: string,
): void {
    if (config !== null) {
        throw new Error("provider ownership manifest is already configured")
    }
    if (!isAbsolute(path) || runToken.length < 8 || runToken.length > 256) {
        throw new Error("invalid provider ownership manifest bootstrap")
    }

    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > MAX_BOOTSTRAP_BYTES) {
        throw new Error("provider ownership manifest must be a bounded regular file")
    }
    const bootstrap = JSON.parse(readFileSync(path, "utf8")) as {
        schemaVersion?: unknown
        runToken?: unknown
        providers?: unknown
    }
    if (
        bootstrap.schemaVersion !== SCHEMA_VERSION ||
        bootstrap.runToken !== runToken ||
        !Array.isArray(bootstrap.providers) ||
        bootstrap.providers.length !== 0
    ) {
        throw new Error("provider ownership manifest bootstrap does not match this run")
    }

    config = { path, runToken, generation: 0 }
    const initial = publishProviderOwnership([])
    if (!initial.ok) {
        config = null
        throw new Error(initial.error)
    }
}

/** Atomically replace the complete set of provider groups owned by this run. */
export function publishProviderOwnership(
    groups: readonly ProviderOwnershipGroup[],
): ProviderOwnershipPublishResult {
    if (config === null) return { ok: true, generation: 0 }
    if (groups.length > MAX_GROUPS) {
        return {
            ok: false,
            error: `provider ownership manifest capacity exceeded (${groups.length} > ${MAX_GROUPS})`,
        }
    }

    const providers: ProviderOwnershipGroup[] = []
    const seenGroups = new Set<number>()
    for (const group of groups) {
        const normalized = normalizeGroup(group)
        if (normalized === null || seenGroups.has(normalized.processGroupId)) {
            return {
                ok: false,
                error: `provider ownership manifest contains an invalid or duplicate group (${group.processGroupId})`,
            }
        }
        seenGroups.add(normalized.processGroupId)
        providers.push(normalized)
    }
    const nextGeneration = config.generation + 1
    let body: string
    try {
        body = JSON.stringify({
            schemaVersion: SCHEMA_VERSION,
            runToken: config.runToken,
            generation: nextGeneration,
            providers,
        })
    } catch (error) {
        return {
            ok: false,
            error: `failed to encode provider ownership manifest: ${error instanceof Error ? error.message : String(error)}`,
        }
    }
    if (Buffer.byteLength(body) > MAX_BOOTSTRAP_BYTES) {
        return {
            ok: false,
            error: `provider ownership manifest exceeds ${MAX_BOOTSTRAP_BYTES} bytes`,
        }
    }

    const temporaryPath = join(
        dirname(config.path),
        `.provider-ownership-${process.pid}-${nextGeneration}.tmp`,
    )
    let fd: number | null = null
    try {
        fd = openSync(temporaryPath, "wx", 0o600)
        writeFileSync(fd, body, "utf8")
        closeSync(fd)
        fd = null
        renameSync(temporaryPath, config.path)
        config.generation = nextGeneration
        return { ok: true, generation: nextGeneration }
    } catch (error) {
        if (fd !== null) {
            try {
                closeSync(fd)
            } catch {
                // Best-effort cleanup after a failed atomic write.
            }
        }
        try {
            unlinkSync(temporaryPath)
        } catch {
            // A stale valid generation is safer than a partial manifest.
        }
        return {
            ok: false,
            error: `failed to publish provider ownership manifest: ${error instanceof Error ? error.message : String(error)}`,
        }
    }
}

function normalizeGroup(
    group: ProviderOwnershipGroup,
): ProviderOwnershipGroup | null {
    if (
        !Number.isSafeInteger(group.processGroupId) ||
        group.processGroupId < 2 ||
        (group.identitySource !== "linux-proc-stat-v1" &&
            group.identitySource !== "posix-ps-lstart-v1") ||
        group.members.length === 0 ||
        group.members.length > MAX_PROVIDER_OWNERSHIP_MEMBERS_PER_GROUP
    ) {
        return null
    }

    const members: ProviderOwnershipMember[] = []
    const seen = new Set<number>()
    for (const member of group.members) {
        if (
            !Number.isSafeInteger(member.pid) ||
            member.pid < 2 ||
            seen.has(member.pid)
        ) {
            return null
        }
        const startTime = member.startTime.trim().replace(/\s+/g, " ")
        if (startTime.length === 0 || startTime.length > 128) return null
        seen.add(member.pid)
        members.push({ pid: member.pid, startTime })
    }
    if (members.length === 0) return null
    return {
        processGroupId: group.processGroupId,
        identitySource: group.identitySource,
        members,
    }
}

/** @internal Release module state between isolated process-registry tests. */
export function resetProviderOwnershipManifestForTests(): void {
    config = null
}
