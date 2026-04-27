# Case: workspace root and child scope

Fixture: `fixtures/workspace-root`

Purpose: verify that `0.1` does not pretend a partial workspace copy is a reliable migration probe.

Useful commands:

```sh
node ./bin/vite8-doctor.mjs fixtures/workspace-root --report json
node ./bin/vite8-doctor.mjs fixtures/workspace-root/packages/app --probe-build --report json
```

Expected signal: workspace root reports child packages, workspace child probe returns `probe-inconclusive`, and both reports include a `workspace-scope` migration hint.
