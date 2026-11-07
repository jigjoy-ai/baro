import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { contentPreservingCommand } from "../../src/acceptance/content-preserving-command.js"

const preserving = (command: string) => contentPreservingCommand(command).preserving

describe("content-preserving commands", () => {
    it("accepts staging, committing and reading", () => {
        for (const command of [
            "git add -A && git commit -m \"Add exporter; tests -> green\"",
            "git add lib/export.mjs lib/export.test.mjs && git commit -m \"$(cat <<'EOF'\nAdd exporter\n\nCo-Authored-By: x\nEOF\n)\"",
            "git status --short",
            "git --no-pager diff --stat HEAD~1",
            "git -C /tmp/wt log --oneline -3 | head -5",
            "cat README.md | grep -n API",
            "sed -n '1,40p' server.mjs",
            "ls -la lib 2>/dev/null; wc -l lib/*.mjs",
            "find . -name '*.test.mjs' -not -path './node_modules/*'",
            "bash -lc 'git add -A && git commit -m done'",
        ]) {
            assert.equal(preserving(command), true, command)
        }
        assert.deepEqual(contentPreservingCommand("git commit -m x"), { preserving: true, commits: true })
        assert.deepEqual(contentPreservingCommand("git status"), { preserving: true, commits: false })
    })

    it("refuses anything that could write, run a program, or that it cannot read", () => {
        for (const command of [
            "npm test",
            "node --test lib/export.test.mjs",
            "echo x > README.md",
            "cat a >> b",
            "git checkout -- server.mjs",
            "git stash",
            "git -c core.fsmonitor=evil status",
            "git diff --output=patch.diff",
            "git commit -m \"$(rm -rf lib)\"",
            "git commit -m \"$(cat <<EOF\n$(touch x)\nEOF\n)\"",
            "sed -i 's/a/b/' server.mjs",
            "sed 's/a/b/' server.mjs",
            "find . -name '*.tmp' -delete",
            "find . -exec rm {} ;",
            "ls | xargs rm",
            "cat a | tee b",
            "echo `touch x`",
            "rg --pre ./script pattern",
            "",
        ]) {
            assert.equal(preserving(command), false, command)
        }
    })
})
