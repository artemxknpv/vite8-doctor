# Validation Notes

These notes explain what `0.1` was checked against before publication. They are development evidence, not part of the npm package.

## Synthetic Cases

The fixture suite covers the stable behavior contract:

- `fixtures/vite-basic`: detects `optimizeDeps`, plugin imports, line evidence, JSON output, and GitHub report output.
- `fixtures/semver-ranges`: verifies semver parsing for plugin `peerDependencies.vite`, including ranges that allow or exclude Vite 8.
- `fixtures/package-peer`: verifies package-level `peerDependencies.vite` for plugin/library packages.
- `fixtures/vite-baseline-broken`: keeps a failing current build separate from a Vite 8 migration failure.
- `fixtures/vite-dual-build`: compares current and temporary Vite 8 build output and reports relative asset deltas.
- `fixtures/vite-large-chunk`: turns build warnings into local-evidence migration hints.
- `fixtures/workspace-root`: reports workspace root/child scope and avoids unsafe partial workspace probes.
- `fixtures/yarn-app`: rejects temporary Vite 8 comparison for Yarn in `0.1`.

Extra generated cases under `/Users/artem/stuff/oss/vite8-doctor-validation/generated` were used for smoke coverage around React/Vue-style apps, baseline failures, workspace shape, and Yarn projects.

## Real OSS Smoke Checks

Real-project checks were run from `/Users/artem/stuff/oss/vite8-doctor-validation/real-oss`.

- `electron-vite-react`: current build passed. The report found `rollupOptions`, `@vitejs/plugin-react` peer metadata that stops before Vite 8, and a temporary Vite 8 failure on declared `vite-plugin-electron-renderer`. That exposed the need for a calibration hint instead of treating the output as clean migration proof.
- `electron-vite-vue`: same class of Electron/Vite app smoke check. Useful for checking report shape and probe behavior on a small real app.
- `vite-react-boilerplate`: standalone React app on Vite 7.2.6. Current and temporary Vite 8 builds passed, but Vite 8 introduced a `vite:react-swc` warning. This exposed the need for a `vite8-new-warning` hint instead of reporting `no-action`.
- `XPoet/vite-vue-starter`: standalone Vue app on Vite 2.5.1. Current build failed under the local runtime, so the report correctly returned `baseline-broken` instead of attributing the failure to Vite 8. It also found `@vitejs/plugin-vue` peer metadata that stops before Vite 8.
- `telegram-mini-apps-dev/vite-boilerplate`: standalone React app on Vite 4.4.5. Current build passed, Vite 8 comparison was rejected because the repo uses Yarn, and plugin peer metadata stopped before Vite 8.
- `hasinhayder/tailwind-boilerplate`: standalone Tailwind app on Vite 4.2.1. Current build passed, Vite 8 comparison was rejected because the repo uses Yarn, and `rollupOptions` was reported as a review signal.
- `ascii-16/react-query-zustand-ts-vite-boilerplate`: standalone React app on Vite 7.0.2. Current and temporary Vite 8 builds passed, but plugin peer metadata stopped before Vite 8 and the Vite 8 build introduced a warning, so the report returned `passed-with-risks`.
- `caoxiemeihao/electron-vite-boilerplate`: standalone Electron/Vite app on Vite 5.0.10. Current and temporary Vite 8 builds passed with no hints, while the plugin list still showed `vite-plugin-electron` has no `peerDependencies.vite`.
- `vite-plugin-pwa`: package-level peer metadata does not declare Vite 8 support, which validates the package peer metadata signal for plugin/library packages.
- `vitepress`, `vinext`, and related plugin repositories: useful as workspace/project-shape smoke checks, not as full compatibility proof.
- `oklch-picker`: already uses Vite 8, so it is only a report/probe smoke check, not Vite 7 to Vite 8 migration evidence.
- `satnaing/astro-paper`: Astro project without a direct Vite dependency. This exposed that framework wrappers should not report `no-action`; they now produce a `framework-wrapper-scope` limitation.

## Current Confidence

`vite8-doctor` is useful as a first-pass migration triage tool. It can tell maintainers whether the current build is already broken, whether local config has known migration-sensitive surfaces, whether package/plugin peer metadata deserves review, and whether a temporary Vite 8 probe changes the build output.

The confidence boundary is explicit:

- It does not prove runtime compatibility.
- It does not safely probe partial workspaces in `0.1`.
- It does not treat missing dependency output from a temp copy as proof by itself.
- It does not treat generic temporary Vite 8 build failures as high-confidence migration proof.
- It does not fully inventory plugins wired through CommonJS `require(...)` in `vite.config.cjs`.
- It depends on the project's own tests for final migration confidence.

The next confidence step is not more static rules by default. It is broader validation on real Vite 7 projects with known Vite 8 migration outcomes.
