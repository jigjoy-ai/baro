/** A goal is a document; a note, a strip or a table shows only its first line. */
export function headline(goal: string, max: number): string {
    const line = goal.split("\n").map((l) => l.trim()).find(Boolean) ?? ""
    return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
