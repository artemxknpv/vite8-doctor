# Case: oklch-picker smoke check

Project: a local checkout of `oklch-picker`

Purpose: verify that `vite8-doctor` can run on a real OSS Vite app and produce a useful triage report.

Useful command:

```sh
node ./bin/vite8-doctor.mjs ../oklch-picker --probe-build --probe-vite8 --allow-install --report github
```

Important limit: this is a smoke check, not Vite 7 to Vite 8 migration proof, because the project already uses Vite 8.
