/**
 * Drain a live pending-work set, including work enqueued while an earlier
 * snapshot is settling. A single Promise.allSettled snapshot is not a barrier.
 */
export async function drainCriticPending(
    pending: ReadonlySet<Promise<void>>,
): Promise<void> {
    while (pending.size > 0) {
        await Promise.allSettled([...pending])
    }
}
