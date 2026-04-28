# JSON Contract

`vite8-doctor --report json` is the machine-readable report format for scripts and AI agents.

The contract is additive within a schema version: new fields may appear, but documented fields should keep their meaning for the same `schemaVersion`.

## Top-Level Fields

- `schemaVersion`: report schema version. `0.1` emits `1`.
- `tool`: tool metadata with `name` and `version`.
- `summary`: compact machine-oriented triage summary.
- `agentGuidance`: safe-use boundary for automated consumers.
- `projectRoot`, `packageName`, `packageManager`, `viteRange`, `configPath`, `configPaths`, `projectShape`: inspected project metadata.
- `risks`: static config findings.
- `plugins`: detected Vite plugin imports and package metadata.
- `probe`: build-probe result when `--probe-build` is used; otherwise absent.
- `migrationHints`: evidence-backed review prompts.

## Summary

`summary.status` is the recommended coarse state for agents:

- `no-action`: no static hints or probe blockers were found.
- `needs-review`: findings exist, but the report does not identify a current build failure or Vite 8 probe failure.
- `baseline-broken`: the current build failed before any Vite 8 comparison.
- `vite8-build-failed`: current build passed, but the temporary Vite 8 build failed.

`summary.confidence` describes report completeness, not app compatibility:

- `low`: static-only report.
- `medium`: probe ran but was inconclusive or has a calibration caveat.
- `high`: probe ran and produced a clear non-failing result without calibration caveats.

Temporary Vite 8 build failures are `medium` confidence in `0.1` because the temp copy installs with lifecycle scripts disabled. Agents should reproduce those failures on a normal branch before treating them as migration evidence.

`summary.autoFixSafe` is always `false` in `0.1`.

## Migration Hints

Each hint has:

- `id`: stable hint identifier.
- `title`: short human label.
- `trigger`: why the hint exists.
- `evidence`: local file, package metadata, build output, or tool limitation data.
- `sourceType`: one of `docs`, `package-metadata`, `local-build-output`, or `tool-limitation`.
- `sourceUrl`: external source URL when available.
- `disclaimer`: what not to infer from the hint.
- `nextStep`: human-readable follow-up.
- `agentAction`: conservative structured follow-up for automation.

`agentAction.autoFixSafe` is always `false` in `0.1`. Agents may plan or draft from these actions, but should not modify project config or dependencies based only on them.

## Agent Guidance

Agents may use the JSON report for:

- migration triage
- issue or PR description drafting
- planning a Vite 8 validation branch
- choosing targeted tests to run next

Agents should not use the report as:

- proof that a project is Vite 8 compatible
- permission to automatically edit config
- permission to automatically change dependencies
- a replacement for the project's own test suite

Frameworks that wrap Vite, such as Astro or Nuxt projects without a direct Vite dependency, are reported as scope limitations. Use those framework migration guides as the primary source.

## Compatibility Notes

Use `schemaVersion` before relying on field shape.

Treat unknown enum values as review-required, not success.

Prefer `summary.status` for coarse routing and `migrationHints[].agentAction` for follow-up planning.

Do not parse human markdown output for automation. Use `--report json`.
