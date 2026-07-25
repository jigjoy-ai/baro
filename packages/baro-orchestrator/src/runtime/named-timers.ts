/**
 * One named slot per concern, exactly-one pending timer per name. Arming a
 * name re-arms it; the entry is removed before `fire` runs so a callback can
 * re-arm its own name (the split-deadline pattern) and `isArmed` is false
 * while it executes.
 */
export class NamedTimers<TName extends string> {
    private readonly timers = new Map<TName, ReturnType<typeof setTimeout>>()

    arm(name: TName, delayMs: number, fire: () => void): void {
        this.clear(name)
        const handle = setTimeout(() => {
            this.timers.delete(name)
            fire()
        }, delayMs)
        this.timers.set(name, handle)
    }

    isArmed(name: TName): boolean {
        return this.timers.has(name)
    }

    clear(name: TName): void {
        const handle = this.timers.get(name)
        if (handle !== undefined) clearTimeout(handle)
        this.timers.delete(name)
    }

    clearAll(): void {
        for (const handle of this.timers.values()) clearTimeout(handle)
        this.timers.clear()
    }
}
