# vite8-doctor

Check a Vite app before moving it to Vite 8 / Rolldown.

`vite8-doctor` scans local config, checks Vite plugin peer ranges, and can run build probes in temp directories. The goal is simple: separate "this project is already broken" from "the Vite 8 build changed something worth looking at".

It does not prove that an app is compatible. It gives you a short report with evidence.

```sh
npx vite8-doctor . --probe-build --report json
```

Use the JSON output for CI scripts, issue triage, and AI coding agents. Use `--probe-vite8 --allow-install` only when dependency installs in a temporary copy are acceptable.

![vite8-doctor terminal report example](https://raw.githubusercontent.com/artemxknpv/vite8-doctor/main/docs/assets/terminal-demo.svg)

## Skip This README

If you are using an AI coding agent, give it this:

```text
Use vite8-doctor to triage this project before a Vite 8 / Rolldown migration.

Run:
npx vite8-doctor . --probe-build --report json

If dependency installs are acceptable in a temporary copy, also run:
npx vite8-doctor . --probe-build --probe-vite8 --allow-install --report json

Read the JSON contract before acting on the report:
https://raw.githubusercontent.com/artemxknpv/vite8-doctor/refs/heads/main/docs/json-contract.md

Use summary.status for routing and migrationHints[].agentAction for follow-up planning.
Do not automatically edit config or dependencies based only on vite8-doctor hints.
Treat the report as migration triage, not compatibility proof.
```

## Usage

Requires Node `^20.19.0 || >=22.12.0`.

```sh
npx vite8-doctor /path/to/project
```

JSON output:

```sh
npx vite8-doctor /path/to/project --json
```

GitHub-ready report:

```sh
npx vite8-doctor /path/to/project --report github
```

Run the current Vite build in a temporary output directory:

```sh
npx vite8-doctor /path/to/project --probe-build
```

Compare it with Vite 8 in a temporary project copy:

```sh
npx vite8-doctor /path/to/project --probe-build --probe-vite8 --allow-install
```

`--probe-vite8` requires `--allow-install` because it installs dependencies in the temporary copy. The original project is not modified.

## What It Checks

- Vite version/range from `package.json`
- root-level `vite.config.*` files, including alternate names such as `electron.vite.config.ts`
- Vite plugin imports
- installed plugin versions and `peerDependencies.vite`
- migration-sensitive config such as `optimizeDeps`, `manualChunks`, `rollupOptions`, `esbuild`, `plugin-legacy`, and custom build targets
- workspace project shape
- framework wrappers with no direct Vite dependency, such as Astro or Nuxt, as scope limitations
- current build status when `--probe-build` is enabled
- temporary Vite 8 build status when `--probe-vite8 --allow-install` is enabled
- migration hints with source URLs or local evidence
- build output deltas when both current and Vite 8 builds run

## Report Formats

- `--report markdown`: default terminal-friendly markdown.
- `--report json`: structured report for scripts.
- `--report github`: paste-ready issue or discussion report.
- `--json`: backward-compatible alias for `--report json`.

The JSON report is meant to be consumed by scripts and AI agents. It includes `schemaVersion`, tool metadata, a machine-oriented `summary`, stable hint ids, and conservative `agentAction` objects. See `docs/json-contract.md`.

## Migration Hints

Hints are prompts for review. They are not compatibility guarantees.

`0.1` covers these signals:

- `optimizeDeps` and `optimizeDeps.esbuildOptions`
- `rollupOptions` and `manualChunks`
- `esbuild`, `plugin-legacy`, and custom build targets
- package and Vite plugin peer metadata that excludes Vite 8
- unavailable plugin metadata when dependencies are missing
- dynamic config-loading scope limits
- framework-wrapper scope limits
- workspace scope limits
- current build failures
- unsupported package managers for temporary Vite 8 comparison
- disabled Yarn Vite 8 comparison
- missing declared dependencies in the temporary Vite 8 copy
- warnings introduced by the temporary Vite 8 build
- Vite large chunk warnings

External migration hints link to Vite docs. Local hints cite package metadata, build output, or tool limitations.

## Probe Classifications

- `passed`: current build passed and no static risks were detected.
- `passed-with-risks`: build passed, but config or plugin metadata deserves review.
- `baseline-broken`: the current build already fails; this is not classified as a Vite 8 migration failure.
- `vite8-build-failed`: current build passed, but the temporary Vite 8 build failed.
- `probe-inconclusive`: the probe was skipped or could not complete.

## Build Output Delta

When both builds run, `vite8-doctor` compares asset count, total bytes, largest assets, warnings, and changed/added/removed asset names.

Asset paths are relative to each build `outDir`. The report should not expose absolute temporary paths.

## Safety Model

Static scanning only reads local files.

Probe mode executes project build tooling. Use it only on projects you trust. It is not a sandbox.

`--probe-build` prefers the existing local Vite binary and can fall back to package-manager exec with a temporary `outDir`.

`--probe-vite8 --allow-install` copies the project to a temporary directory, skips `.git`, `.nx`, `node_modules`, `.omx`, `.tasks`, `.ai`, `.omc`, common build output, `.env*`, `.npmrc`, `.yarnrc*`, and `.pnpmfile.cjs`, then installs Vite 8 inside that copy.

npm and pnpm installs use `--ignore-scripts`. Other package managers, including Yarn and Bun, are rejected in `0.1` because lifecycle-script suppression is not handled safely yet.

Probe subprocesses run with a reduced environment. Known secret values from the parent environment are redacted from captured output, but project tooling can still print sensitive data from files it reads itself. Review reports before pasting them into public issues.

## Workspace Scope

`0.1` supports standalone package probes.

Workspace roots are reported as `workspace-root` with detected child packages. Workspace child packages are reported as `workspace-child`; probe mode returns `probe-inconclusive` with `unsupported-workspace-child`.

This avoids a bad result from copying one child package without the workspace around it.

## Example

```md
# vite8-doctor report

project: oklch-picker
package manager: pnpm
vite range: ^8.0.8
project shape: standalone

## config risks
- [medium] rollup-options: rollupOptions are worth probing because Vite 8 routes build behavior through Rolldown.
  evidence: vite.config.ts:15 `rollupOptions: {`

## plugin peer ranges
- vite-plugin-pug-transformer: 1.0.8, peer vite ^2.5.10 || ^3.0.0 || ^4.0.0 || ^5.0.0 || ^6.0.0 || ^7.0.0; does not declare vite 8 support
  note: peer metadata can lag behind actual compatibility; this is a review signal, not proof of breakage.
```

## Limitations

- Static findings are review signals, not failures.
- Peer dependency metadata can lag behind actual compatibility.
- Missing plugin metadata means the dependency graph is not installed or not inspectable; it is not a compatibility signal.
- Frameworks that wrap Vite without a direct Vite dependency or `vite.config.*` are outside `0.1`'s direct migration scope.
- A missing dependency in the temporary Vite 8 copy can be a temp install artifact. Reproduce it on a normal branch before treating it as a migration failure.
- A temporary Vite 8 build failure is not proof by itself because the temp copy installs with lifecycle scripts disabled.
- Plugin detection covers common ESM imports and CommonJS `require(...)` calls, but it is still a static scan. Dynamic plugin loading is reported as a scope limitation, not resolved automatically.
- AI agents should use JSON output for triage, issue drafting, and migration planning. They should not automatically edit config or dependencies based only on `vite8-doctor` hints.
- Runtime correctness still requires the project's own tests.
- Workspace-aware temp probes are not supported in `0.1`.
- Hints are a small initial catalog, not a full Vite 8 issue database.
- Plug'n'Play-specific detection is deferred until there is a real signal and a fixture.

## Case Studies

Local development cases live under `docs/cases/`. They are excluded from the npm package by the package `files` allowlist.

See `docs/validation.md` for the generated and real-project validation notes behind the `0.1` scope.

## Development

```sh
node --test
node ./bin/vite8-doctor.mjs --help
node ./bin/vite8-doctor.mjs fixtures/vite-basic --json
node ./bin/vite8-doctor.mjs fixtures/vite-baseline-broken --probe-build --json
node ./bin/vite8-doctor.mjs fixtures/vite-dual-build --probe-build --probe-vite8 --allow-install --report github
npm pack --dry-run --json
```
