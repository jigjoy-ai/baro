#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs"
import { resolve } from "node:path"
import ts from "typescript"

const [holdoutArgument, protocolArgument = "src/protocol.ts"] = process.argv.slice(2)

if (!holdoutArgument) {
    console.error("usage: node verify-typescript-holdout.mjs <holdout.ts> [protocol.ts]")
    process.exit(2)
}

const checkedPath = (argument, label) => {
    const path = resolve(argument)
    if (!existsSync(path)) {
        console.error(`${label} not found: ${path}`)
        process.exit(2)
    }
    return realpathSync(path)
}

const holdoutPath = checkedPath(holdoutArgument, "holdout")
const protocolPath = checkedPath(protocolArgument, "protocol")
const options = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    types: [],
}
const host = ts.createCompilerHost(options)

host.resolveModuleNames = (moduleNames, containingFile) =>
    moduleNames.map((moduleName) => {
        if (resolve(containingFile) === holdoutPath && moduleName === "./protocol.js") {
            return {
                extension: ts.Extension.Ts,
                isExternalLibraryImport: false,
                resolvedFileName: protocolPath,
            }
        }
        return ts.resolveModuleName(moduleName, containingFile, options, host).resolvedModule
    })

const program = ts.createProgram([holdoutPath], options, host)
const diagnostics = ts.getPreEmitDiagnostics(program)

if (diagnostics.length > 0) {
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => "\n",
    }))
    process.exit(1)
}

console.log(`holdout passed: ${holdoutPath} -> ${protocolPath}`)
