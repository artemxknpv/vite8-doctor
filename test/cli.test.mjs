import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(repoRoot, 'bin', 'vite8-doctor.mjs')

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options
  })
}

function json(args) {
  const result = run([...args, '--json'])
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function reportJson(args) {
  const result = run([...args, '--report', 'json'])
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function writeExecutable(file, source) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, source)
  fs.chmodSync(file, 0o755)
}

test('prints help', () => {
  const result = run(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /--probe-build/)
  assert.match(result.stdout, /--report FORMAT/)
})

test('unknown flag exits without a stack trace', () => {
  const result = run(['--unknown'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Unknown argument/)
  assert.doesNotMatch(result.stderr, /at .*vite8-doctor/)
})

test('reports config risk and line evidence', () => {
  const report = json(['fixtures/vite-basic'])
  assert.equal(report.schemaVersion, 1)
  assert.deepEqual(report.tool, { name: 'vite8-doctor', version: '0.1.0' })
  assert.equal(report.projectShape.kind, 'standalone')
  assert.equal(report.risks[0].id, 'optimize-deps')
  assert.equal(report.risks[0].evidence.line, 6)
  assert.match(report.risks[0].evidence.snippet, /optimizeDeps/)
  assert.equal(report.plugins[0].vite8PeerSupported, true)
  assert.equal(report.plugins[1].spec, 'vite-plugin-wide-range')
  assert.equal(report.plugins[1].vitePeerRange, '>=5 <9')
  assert.equal(report.plugins[1].vite8PeerSupported, true)
  assert.equal(report.environment.packageName, 'vite-basic-fixture')
  assert.equal(report.environment.projectShape, 'standalone')
  assert.deepEqual(report.migrationHints.map(hint => hint.id), ['optimize-deps'])
  assert.equal(report.migrationHints[0].agentAction.kind, 'run-focused-tests')
  assert.equal(report.migrationHints[0].agentAction.autoFixSafe, false)
  assert.equal(report.summary.status, 'needs-review')
  assert.equal(report.summary.confidence, 'low')
  assert.deepEqual(report.summary.recommendedActions.map(action => action.hintId), ['optimize-deps'])
  assert.equal(report.agentGuidance.autoFixSafe, false)
  assert.ok(report.agentGuidance.notFor.includes('automatic-config-edits'))
})

test('--report json matches --json alias', () => {
  const aliasReport = json(['fixtures/vite-basic'])
  const explicitReport = reportJson(['fixtures/vite-basic'])
  assert.equal(explicitReport.packageName, aliasReport.packageName)
  assert.equal(explicitReport.environment.nodeVersion, process.version)
  assert.equal(explicitReport.migrationHints[0].sourceUrl, 'https://vite.dev/guide/migration.html')
})

test('--report has precedence over --json alias', () => {
  const result = run(['fixtures/vite-basic', '--report', 'github', '--json'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^## vite8-doctor report/)
})

test('prints a paste-ready GitHub report', () => {
  const result = run(['fixtures/vite-basic', '--report', 'github'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /## vite8-doctor report/)
  assert.match(result.stdout, /### Environment/)
  assert.match(result.stdout, /### migration hints/)
  assert.match(result.stdout, /Migration hint only/)
  assert.match(result.stdout, /evidence: .*vite.config.js:6/)
})

test('classifies baseline build failure separately', () => {
  const report = json(['fixtures/vite-baseline-broken', '--probe-build'])
  assert.equal(report.probe.classification, 'baseline-broken')
  assert.equal(report.summary.status, 'baseline-broken')
  assert.equal(report.summary.confidence, 'high')
  assert.equal(report.probe.current.ok, false)
  assert.match(report.probe.current.output, /fixture build failed/)
  assert.equal(report.migrationHints.find(hint => hint.id === 'baseline-broken').sourceType, 'local-build-output')
})

test('uses semver semantics for Vite 8 peer support', () => {
  const report = json(['fixtures/semver-ranges'])
  const bySpec = Object.fromEntries(report.plugins.map(plugin => [plugin.spec, plugin]))
  assert.equal(bySpec['vite-plugin-wide-lt'].vitePeerRange, '>=5 <8.1')
  assert.equal(bySpec['vite-plugin-wide-lt'].vite8PeerSupported, true)
  assert.equal(bySpec['vite-plugin-hyphen-range'].vitePeerRange, '7 - 8')
  assert.equal(bySpec['vite-plugin-hyphen-range'].vite8PeerSupported, true)
  assert.equal(bySpec['vite-plugin-v7-only'].vitePeerRange, '^7.0.0')
  assert.equal(bySpec['vite-plugin-v7-only'].vite8PeerSupported, false)
  const peerHint = report.migrationHints.find(hint => hint.id === 'plugin-peer-metadata')
  assert.equal(peerHint.sourceType, 'package-metadata')
  assert.match(peerHint.disclaimer, /not proof of breakage/)
})

test('distinguishes unavailable plugin metadata from missing Vite peer metadata', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vite8-doctor-plugin-metadata-'))
  try {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      private: true,
      type: 'module',
      devDependencies: { vite: '^7.3.0' }
    }))
    fs.writeFileSync(path.join(tmp, 'vite.config.js'), [
      "import missing from 'vite-plugin-missing'",
      "import noPeer from 'vite-plugin-no-peer'",
      'export default { plugins: [missing(), noPeer()] }'
    ].join('\n'))
    fs.mkdirSync(path.join(tmp, 'node_modules', 'vite-plugin-no-peer'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'node_modules', 'vite-plugin-no-peer', 'package.json'), JSON.stringify({
      name: 'vite-plugin-no-peer',
      version: '1.0.0'
    }))

    const report = reportJson([tmp])
    const bySpec = Object.fromEntries(report.plugins.map(plugin => [plugin.spec, plugin]))
    assert.equal(bySpec['vite-plugin-missing'].metadataStatus, 'package-missing')
    assert.equal(bySpec['vite-plugin-no-peer'].metadataStatus, 'no-vite-peer')
    assert.equal(bySpec['vite-plugin-no-peer'].vite8PeerSupported, null)
    assert.equal(
      report.migrationHints.filter(hint => hint.id === 'plugin-metadata-unavailable').length,
      1
    )

    const github = run([tmp, '--report', 'github'])
    assert.equal(github.status, 0, github.stderr)
    assert.match(github.stdout, /metadata unavailable: package is not installed/)
    assert.match(github.stdout, /package has no peerDependencies\.vite/)
    assert.match(github.stdout, /plugin metadata unavailable: 1/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('flags package-level Vite peer metadata that excludes Vite 8', () => {
  const report = json(['fixtures/package-peer'])
  assert.equal(report.ownVitePeerRange, '^7.0.0')
  assert.equal(report.ownVite8PeerSupported, false)
  const hint = report.migrationHints.find(candidate => candidate.id === 'package-peer-metadata')
  assert.equal(hint.sourceType, 'package-metadata')
  assert.match(hint.evidence.vitePeerRange, /\^7/)
})

test('detects workspace root instead of a clean standalone report', () => {
  const report = json(['fixtures/workspace-root'])
  assert.equal(report.projectShape.kind, 'workspace-root')
  assert.equal(report.projectShape.childPackageCount, 1)
  assert.equal(report.migrationHints.find(hint => hint.id === 'workspace-scope').sourceType, 'tool-limitation')
})

test('does not probe workspace child packages in 0.1', () => {
  const report = json(['fixtures/workspace-root/packages/app', '--probe-build'])
  assert.equal(report.projectShape.kind, 'workspace-child')
  assert.equal(report.probe.classification, 'probe-inconclusive')
  assert.equal(report.probe.current.reason, 'unsupported-workspace-child')
  assert.match(report.probe.current.output, /does not support workspace-child/)
  assert.equal(report.migrationHints.find(hint => hint.id === 'workspace-scope').id, 'workspace-scope')
})

test('skips Vite 8 comparison unless install is explicitly allowed', () => {
  const report = json(['fixtures/vite-basic', '--probe-build', '--probe-vite8'])
  assert.equal(report.probe.classification, 'probe-inconclusive')
  assert.equal(report.probe.vite8.skipped, true)
  assert.match(report.probe.vite8.reason, /--allow-install/)
})

test('rejects Yarn Vite 8 comparison in 0.1 safety model', () => {
  const report = json(['fixtures/yarn-app', '--probe-build', '--probe-vite8', '--allow-install'])
  assert.equal(report.packageManager, 'yarn')
  assert.equal(report.probe.classification, 'probe-inconclusive')
  assert.equal(report.probe.vite8.install.step, 'unsupported-package-manager')
  assert.match(report.probe.vite8.install.output, /Yarn/)
  assert.equal(report.migrationHints.find(hint => hint.id === 'yarn-vite8-comparison').sourceType, 'tool-limitation')
})

test('detects large chunk warnings from local build output', () => {
  const report = reportJson(['fixtures/vite-large-chunk', '--probe-build'])
  const hint = report.migrationHints.find(candidate => candidate.id === 'large-chunk-warning')
  assert.equal(hint.sourceType, 'local-build-output')
  assert.match(hint.evidence.warnings[0], /larger than 500 kB/)
  assert.equal(report.probe.current.assets.largest[0].file, 'assets/app.js')
})

test('flags missing declared dependencies from the temporary Vite 8 copy as calibration risk', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vite8-doctor-temp-copy-risk-'))
  const fakeBin = path.join(tmp, 'fake-bin')
  try {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      private: true,
      type: 'module',
      devDependencies: {
        vite: '^7.3.0',
        'declared-missing': '1.0.0'
      }
    }))
    fs.writeFileSync(path.join(tmp, 'index.html'), '<script type="module" src="/src/main.js"></script>')
    fs.mkdirSync(path.join(tmp, 'src'))
    fs.writeFileSync(path.join(tmp, 'src', 'main.js'), 'console.log("temp copy risk")')
    writeExecutable(path.join(tmp, 'node_modules', '.bin', 'vite'), [
      '#!/usr/bin/env sh',
      'exit 0'
    ].join('\n'))
    writeExecutable(path.join(fakeBin, 'npm'), [
      '#!/usr/bin/env sh',
      'mkdir -p node_modules/.bin',
      'cat > node_modules/.bin/vite <<\\EOF',
      '#!/usr/bin/env sh',
      'echo "Error: dependency \\"declared-missing\\" not found" >&2',
      'exit 1',
      'EOF',
      'chmod +x node_modules/.bin/vite',
      'exit 0'
    ].join('\n'))

    const result = run([tmp, '--probe-build', '--probe-vite8', '--allow-install', '--report', 'json'], {
      env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` }
    })
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.probe.classification, 'vite8-build-failed')
    assert.equal(report.summary.status, 'vite8-build-failed')
    assert.equal(report.summary.confidence, 'medium')
    assert.equal(report.probe.tempCopyRisk.dependency, 'declared-missing')
    const hint = report.migrationHints.find(candidate => candidate.id === 'temp-copy-install-risk')
    assert.equal(hint.sourceType, 'local-build-output')
    assert.equal(hint.agentAction.kind, 'verify-temp-copy-failure')
    assert.equal(hint.agentAction.target, 'declared-missing')
    assert.match(hint.disclaimer, /temp-copy\/install artifact/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('unformalized static risk does not change probe classification without a hint contract', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vite8-doctor-unformalized-risk-'))
  try {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      private: true,
      type: 'module',
      devDependencies: { vite: '^7.3.0' }
    }))
    fs.writeFileSync(path.join(tmp, 'vite.config.js'), 'export default { build: { target: "es2020" } }\n')
    fs.mkdirSync(path.join(tmp, 'node_modules', '.bin'), { recursive: true })
    const viteBin = path.join(tmp, 'node_modules', '.bin', 'vite')
    fs.writeFileSync(viteBin, '#!/usr/bin/env sh\nexit 0\n')
    fs.chmodSync(viteBin, 0o755)
    const report = reportJson([tmp, '--probe-build'])
    assert.equal(report.risks[0].id, 'build-target')
    assert.equal(report.migrationHints.length, 0)
    assert.equal(report.probe.classification, 'passed')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('human reports render structured local evidence for hints', () => {
  const result = run(['fixtures/semver-ranges', '--report', 'github'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /source: package-metadata/)
  assert.match(result.stdout, /evidence: vite-plugin-v7-only peer vite \^7\.0\.0 in /)
})

test('reports Vite 8 asset delta with relative paths', () => {
  const report = reportJson(['fixtures/vite-dual-build', '--probe-build', '--probe-vite8', '--allow-install'])
  assert.ok(report.probe.assetDelta)
  assert.equal(report.probe.classification, 'passed')
  const files = [
    ...report.probe.current.assets.files.map(file => file.file),
    ...report.probe.vite8.build.assets.files.map(file => file.file),
    report.probe.assetDelta.largestCurrent.file,
    report.probe.assetDelta.largestVite8.file,
    ...report.probe.assetDelta.added.map(file => file.file),
    ...report.probe.assetDelta.removed.map(file => file.file),
    ...report.probe.assetDelta.changed.map(file => file.file)
  ]
  assert.ok(files.length > 0)
  for (const file of files) {
    assert.equal(path.isAbsolute(file), false, file)
    assert.doesNotMatch(file, /vite8-doctor-/)
  }
})

test('probe subprocesses do not inherit ambient secret environment values', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vite8-doctor-env-test-'))
  try {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      private: true,
      type: 'module',
      devDependencies: { vite: '^7.3.0' }
    }))
    writeExecutable(path.join(tmp, 'node_modules', '.bin', 'vite'), [
      '#!/usr/bin/env sh',
      'echo "secret=${VITE8_DOCTOR_SECRET:-missing}"',
      'exit 0'
    ].join('\n'))
    const result = run([tmp, '--probe-build', '--report', 'json'], {
      env: { ...process.env, VITE8_DOCTOR_SECRET: 'super-secret-token' }
    })
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stdout, /super-secret-token/)
    assert.match(JSON.parse(result.stdout).probe.current.output, /secret=missing/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('temporary Vite 8 project copy excludes secret-bearing dotfiles', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vite8-doctor-copy-test-'))
  try {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      private: true,
      type: 'module',
      devDependencies: { vite: '^7.3.0' }
    }))
    fs.writeFileSync(path.join(tmp, 'index.html'), '<script type="module" src="/src/main.js"></script>')
    fs.mkdirSync(path.join(tmp, 'src'))
    fs.writeFileSync(path.join(tmp, 'src', 'main.js'), 'console.log("copy test")')
    fs.writeFileSync(path.join(tmp, '.env'), 'PRIVATE_TOKEN=secret')
    fs.writeFileSync(path.join(tmp, '.env.local'), 'PRIVATE_TOKEN=secret')
    fs.writeFileSync(path.join(tmp, '.npmrc'), '//registry.npmjs.org/:_authToken=secret')
    fs.writeFileSync(path.join(tmp, '.yarnrc.yml'), 'npmAuthToken: secret')
    fs.writeFileSync(path.join(tmp, '.pnpmfile.cjs'), 'module.exports = {}')
    writeExecutable(path.join(tmp, 'node_modules', '.bin', 'vite'), [
      '#!/usr/bin/env sh',
      'out=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--outDir" ]; then shift; out="$1"; fi',
      '  shift',
      'done',
      'if [ -n "$out" ]; then mkdir -p "$out"; printf ok > "$out/index.html"; fi',
      'exit 0'
    ].join('\n'))
    const report = reportJson([tmp, '--probe-build', '--probe-vite8', '--allow-install', '--keep-temp'])
    const tempProject = path.join(report.probe.tempRoot, 'project')
    for (const file of ['.env', '.env.local', '.npmrc', '.yarnrc.yml', '.pnpmfile.cjs']) {
      assert.equal(fs.existsSync(path.join(tempProject, file)), false, file)
    }
    fs.rmSync(report.probe.tempRoot, { recursive: true, force: true })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('dry-run package contents are restricted', () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  const [pack] = JSON.parse(result.stdout)
  const files = pack.files.map(file => file.path).sort()
  assert.deepEqual(files, [
    'LICENSE',
    'README.md',
    'bin/vite8-doctor.mjs',
    'package.json'
  ])
})

test('packed tarball exposes the bin entry', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vite8-doctor-pack-test-'))
  try {
    const packResult = spawnSync('npm', ['pack', '--pack-destination', tmp], {
      cwd: repoRoot,
      encoding: 'utf8'
    })
    assert.equal(packResult.status, 0, packResult.stderr)
    const tarball = path.join(tmp, packResult.stdout.trim().split(/\r?\n/).at(-1))
    const installRoot = path.join(tmp, 'consumer')
    fs.mkdirSync(installRoot)
    fs.writeFileSync(path.join(installRoot, 'package.json'), '{"type":"module"}')
    const install = spawnSync('npm', ['install', tarball, '--ignore-scripts'], {
      cwd: installRoot,
      encoding: 'utf8'
    })
    assert.equal(install.status, 0, install.stderr)
    const help = spawnSync(path.join(installRoot, 'node_modules', '.bin', 'vite8-doctor'), ['--help'], {
      cwd: installRoot,
      encoding: 'utf8'
    })
    assert.equal(help.status, 0, help.stderr)
    assert.match(help.stdout, /vite8-doctor/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
