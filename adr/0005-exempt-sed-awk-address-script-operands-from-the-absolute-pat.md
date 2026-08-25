# ADR-0005: Exempt sed/awk address/script operands from the absolute-path classifier, scoped by command name

**Status:** Accepted
**Context:** tokenizeShell strips quotes without retaining metadata (1863-1941), so `sed -n '/panicked/,+8p' out.log` reaches the generic operand branch (1518-1527) as the bare word `/panicked/,+8p` and `path.isAbsolute` (1552) rejects it. Preserving a 'was quoted' flag and skipping path checks for quoted words was rejected: it would let `cat "/etc/passwd"` through, violating a hard constraint. Widening rejectPathOperand was rejected: it is shared by redirect targets and cd targets.
**Decision:** In packages/baro-orchestrator/src/planning/adapters/codebase-tools.ts only, add a module-private predicate placed next to `rejectPathOperand`:
`function isSedAwkScriptOperand(word: string): boolean` — returns true iff ALL of:
  a. `word.startsWith("/")`;
  b. there is a closing unescaped `/` at some index > 0 (a `/` not immediately preceded by `\`);
  c. the suffix after that closing `/` matches one of these shapes exactly:
     - empty string;
     - starts with `,` (range address, covers `,+8p`, `,/end/p`, `,$p`);
     - starts with `!`;
     - starts with `{`, or with whitespace followed by `{`;
     - is a single sed command letter from the set `p d q n N D P h H g G x l = z Z F`, optionally followed by exactly one of `;`, `}` or `!`;
     - starts with `s` or `y` followed by a non-alphanumeric delimiter character (covers `/re/s/a/b/g`).
  Anything else returns false.
Wire it in at the generic operand branch (1518-1527) ONLY: when the current simple command's command word (basename of the first word, reusing the per-simple-command command-name state the `cd` branch at 1490 already relies on) is exactly `sed` or `awk`, and the word is neither the command word nor a redirect target nor a `cd` target, and `isSedAwkScriptOperand(word)` is true, `continue` without calling `rejectPathOperand` (and therefore without the traversal-spelling check, since the token is a script, not a path). Otherwise fall through to the existing call unchanged.
Do NOT change tokenizeShell, rejectPathOperand, safePath, rejectTraversalSpelling, the redirect-target branch, the command-word branch, the cd branch, or any rejection message. Do NOT extend the exemption to any other command name.
**Consequences:** `sed -n '/panicked/,+8p' out.log` and `sed -n '/start/,/end/p' out.log` pass; `cat /etc/passwd` still rejects (command name is not sed/awk); `ls /Users` still rejects (not sed/awk, and no closing `/` anyway); `sed -n p /etc/passwd` still rejects (suffix `passwd` is not a valid command-letter shape) and `sed /Users/me/x.txt` still rejects for the same reason. Real file operands of sed/awk keep being containment-checked. Many awk scripts remain rejected earlier by the `$` guard (1915-1917); that is pre-existing and explicitly out of scope.
