# Case: controlled Vite 7 to Vite 8 build diff

Fixture: `fixtures/vite-dual-build`

Purpose: verify that `vite8-doctor` can compare a passing current build with a temporary Vite 8 build and report asset deltas without leaking absolute temp paths.

Useful command:

```sh
node ./bin/vite8-doctor.mjs fixtures/vite-dual-build --probe-build --probe-vite8 --allow-install --report github
```

Expected signal: `passed` classification, current/Vite 8 asset summaries, and relative asset names in the delta.
