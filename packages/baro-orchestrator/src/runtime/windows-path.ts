const MAX_PLAIN_PATH_CHARS = 247

/**
 * `\\?\C:\dir` → `C:\dir`, `\\?\UNC\host\share` → `\\host\share`. Node 24's
 * `realpathSync` fails on the verbatim form with `EISDIR … lstat 'C:'` (#202),
 * so a `--cwd` is normalized before any filesystem call. Paths that only exist
 * in verbatim form (too long, device paths) are returned unchanged.
 */
export function plainWindowsPath(path: string): string {
    if (!path.startsWith("\\\\?\\")) return path
    const rest = path.slice(4)
    const plain = rest.startsWith("UNC\\")
        ? `\\\\${rest.slice(4)}`
        : /^[A-Za-z]:/.test(rest)
            ? rest
            : null
    if (
        plain === null ||
        plain.length > MAX_PLAIN_PATH_CHARS ||
        plain.split("\\").some((part) => /[. ]$/.test(part))
    ) return path
    return plain
}
