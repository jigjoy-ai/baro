# CLAUDE.md

## Project Overview

**Baro** is a dual-stack project combining Rust and TypeScript/Node.js. It appears to be a TUI (terminal user interface) application with an accompanying web/app component. The project uses Rust for core functionality and TypeScript for the application layer.

## Tech Stack

- **Rust**: Core TUI application (baro-tui crate)
- **TypeScript/Node.js**: Main application layer (baro-app package)
- **Cargo**: Rust package manager and build system
- **npm**: Node.js package manager

## Directory Structure

```
baro/
├── crates/              # Rust workspace
│   └── baro-tui/        # Main Rust TUI crate
│       ├── Cargo.toml
│       └── src/
├── packages/            # Node.js workspace
│   └── baro-app/        # Main application
│       ├── package.json
│       ├── src/
│       ├── bin/
│       ├── scripts/
│       └── tsconfig.json
├── .github/workflows/   # CI/CD pipelines
│   └── release.yml
├── Cargo.toml           # Root Rust workspace manifest
├── package.json         # Root Node.js manifest
├── Cargo.lock
├── package-lock.json
├── README.md
├── prd.json            # Product requirements document
└── assets/
    └── screenshot.png
```

## Build Commands

**Rust:**
```bash
cargo build      # Build the Rust project
cargo test       # Run Rust tests
```

**Node.js:**
```bash
npm install      # Install dependencies
npm run [script] # Run scripts defined in package.json
```

## Key Files

- **Cargo.toml**: Root Rust workspace configuration
- **package.json**: Root Node.js configuration
- **crates/baro-tui/src/**: Rust TUI implementation
- **packages/baro-app/src/**: TypeScript application source
- **.github/workflows/release.yml**: Release pipeline configuration
- **prd.json**: Product specifications and requirements

## Development Conventions

- Uses Rust workspace for crate management (monorepo structure)
- Uses npm/Node.js workspace for package management
- Release workflow defined in GitHub Actions
- No linter or formatter configuration detected in scan (may exist but not documented)

## Comment Style

Keep comments lean: a comment earns its place only by stating a non-obvious
constraint or "why" the code can't show. Do NOT write: narration of the next
line, section banner dividers, JSDoc/field docs that repeat the name or the
clap attribute, multi-paragraph rationale essays (compress to 1-3 lines), or
changelog-style history. Stream/protocol format specs live in `docs/`, not in
file headers. Exception: `///` doc comments on clap args in `cli/cli.rs` are
user-facing `--help` text — keep them, but one concise line each.

## Notes

- Both Rust and Node.js must be installed for full development
- Root Cargo.toml and package.json manage the monorepo
- Release automation is configured via GitHub Actions
- Check `scripts/` directory in baro-app for development/build utilities