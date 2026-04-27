# Case: baseline build already broken

Fixture: `fixtures/vite-baseline-broken`

Purpose: verify that a failing current build is not mislabeled as a Vite 8 migration failure.

Useful command:

```sh
node ./bin/vite8-doctor.mjs fixtures/vite-baseline-broken --probe-build --report github
```

Expected signal: `baseline-broken` classification and a hint telling the maintainer to fix the current build before attributing failures to Vite 8.
