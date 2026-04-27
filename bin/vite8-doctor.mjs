#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import semver from 'semver'

const CONFIG_NAMES = [
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cts',
  'vite.config.cjs'
]

const RISK_PATTERNS = [
  {
    id: 'optimize-deps-esbuild-options',
    level: 'high',
    re: /optimizeDeps\s*:\s*{[\s\S]*?esbuildOptions\s*:/m,
    message: 'optimizeDeps.esbuildOptions is a Vite 8 migration risk because Rolldown changes the optimizer surface.'
  },
  {
    id: 'optimize-deps',
    level: 'medium',
    re: /optimizeDeps\s*:/m,
    message: 'optimizeDeps customization should be checked against Vite 8 dependency optimization behavior.'
  },
  {
    id: 'rollup-output-manual-chunks',
    level: 'high',
    re: /manualChunks\s*:/m,
    message: 'manualChunks can behave differently across Rollup/Rolldown chunking.'
  },
  {
    id: 'rollup-options',
    level: 'medium',
    re: /rollupOptions\s*:/m,
    message: 'rollupOptions are worth probing because Vite 8 routes build behavior through Rolldown.'
  },
  {
    id: 'esbuild-config',
    level: 'high',
    re: /(^|[^\w])esbuild\s*:/m,
    message: 'top-level esbuild config is a Vite 8 migration risk.'
  },
  {
    id: 'esbuild-minify',
    level: 'high',
    re: /minify\s*:\s*['"]esbuild['"]/m,
    message: 'build.minify: "esbuild" should be revisited for Vite 8.'
  },
  {
    id: 'plugin-legacy',
    level: 'high',
    re: /@vitejs\/plugin-legacy|legacy\s*\(/m,
    message: '@vitejs/plugin-legacy is a known Vite 8 migration area.'
  },
  {
    id: 'build-target',
    level: 'medium',
    re: /target\s*:/m,
    message: 'custom build targets should be checked after the Rolldown migration.'
  }
]

const DEFAULT_TIMEOUT_MS = 120_000
const OUTPUT_LIMIT = 12_000
const LARGE_CHUNK_RE = /larger than 500 kB/i
const VITE_MIGRATION_DOC = 'https://vite.dev/guide/migration.html'
const VITE_ROLLDOWN_DOC = 'https://vite.dev/guide/rolldown'
const SAFE_ENV_KEYS = [
  'CI',
  'HOME',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'PATH',
  'SHELL',
  'SystemRoot',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'XDG_CACHE_HOME'
]
const SENSITIVE_ENV_RE = /(?:TOKEN|SECRET|PASSWORD|PASS|AUTH|COOKIE|CREDENTIAL|NPM_CONFIG_.*(?:_AUTH|TOKEN))/i
const COPY_EXCLUDES = new Set([
  '.git',
  '.nx',
  '.omx',
  '.tasks',
  '.turbo',
  '.vite',
  '.ai',
  '.omc',
  '.npmrc',
  '.pnpmfile.cjs',
  '.yarnrc',
  '.yarnrc.yml',
  'build',
  'coverage',
  'dist',
  'node_modules'
])

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function findUp(start, fileName) {
  let current = path.resolve(start)
  while (true) {
    const candidate = path.join(current, fileName)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function findConfig(root) {
  for (const name of CONFIG_NAMES) {
    const candidate = path.join(root, name)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function hasOwnPackageJson(dir) {
  return fs.existsSync(path.join(dir, 'package.json'))
}

function findWorkspaceRoot(start) {
  let current = path.resolve(start)
  while (true) {
    const pkgPath = path.join(current, 'package.json')
    const hasPnpmWorkspace = fs.existsSync(path.join(current, 'pnpm-workspace.yaml'))
    if (hasPnpmWorkspace) return current
    if (fs.existsSync(pkgPath)) {
      const pkg = readJson(pkgPath)
      if (pkg.workspaces) return current
    }
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function detectProjectShape(projectRoot) {
  const workspaceRoot = findWorkspaceRoot(projectRoot)
  if (!workspaceRoot) return { kind: 'standalone' }
  if (path.resolve(workspaceRoot) === path.resolve(projectRoot)) {
    const childPackages = findChildPackageRoots(workspaceRoot)
    return {
      kind: 'workspace-root',
      workspaceRoot,
      childPackageCount: childPackages.length,
      childPackages: childPackages.slice(0, 50)
    }
  }
  return {
    kind: 'workspace-child',
    workspaceRoot,
    reason: 'workspace child package probes are unsupported in 0.1 because temp-copying only the child can misrepresent the real workspace graph'
  }
}

function findChildPackageRoots(workspaceRoot) {
  const results = []
  walk(workspaceRoot, 0, file => {
    if (path.basename(file) === 'package.json' && path.dirname(file) !== workspaceRoot) {
      results.push(path.dirname(file))
    }
  })
  return results.sort()
}

function walk(dir, depth, visitFile) {
  if (depth > 5) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (COPY_EXCLUDES.has(entry.name)) continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(fullPath, depth + 1, visitFile)
    } else if (entry.isFile()) {
      visitFile(fullPath)
    }
  }
}

function collectDeps(pkg) {
  return {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {})
  }
}

function detectPackageManager(root, pkg) {
  if (pkg.packageManager) {
    return pkg.packageManager.split('@')[0]
  }
  const workspacePackage = findPackageManagerDeclaration(root)
  if (workspacePackage) return workspacePackage
  if (findUp(root, 'pnpm-lock.yaml')) return 'pnpm'
  if (findUp(root, 'yarn.lock')) return 'yarn'
  if (findUp(root, 'package-lock.json')) return 'npm'
  return 'npm'
}

function findPackageManagerDeclaration(start) {
  let current = path.resolve(start)
  while (true) {
    const candidate = path.join(current, 'package.json')
    if (fs.existsSync(candidate)) {
      const pkg = readJson(candidate)
      if (pkg.packageManager) return pkg.packageManager.split('@')[0]
    }
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function extractPluginImports(source) {
  const plugins = new Map()
  const importRe = /from\s+['"]([^'"]+)['"]/g
  let match
  while ((match = importRe.exec(source))) {
    const spec = match[1]
    if (
      spec === '@tailwindcss/vite' ||
      spec === '@react-router/dev/vite' ||
      spec === '@vitejs/plugin-legacy' ||
      spec === 'vite-tsconfig-paths' ||
      spec.startsWith('@vitejs/plugin-') ||
      spec.startsWith('vite-plugin-') ||
      spec.includes('/vite')
    ) {
      plugins.set(spec, findSourceEvidence(source, match.index, spec))
    }
  }
  return [...plugins.entries()].map(([spec, evidence]) => ({ spec, evidence }))
}

function packageNameFromSubpath(spec) {
  if (spec.startsWith('@')) {
    const parts = spec.split('/')
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec
  }
  return spec.split('/')[0]
}

function readInstalledPackage(root, spec) {
  const requireFromRoot = createRequire(path.join(root, 'package.json'))
  const packageName = packageNameFromSubpath(spec)
  const directPackageJson = findPackageJsonInNodeModules(root, packageName)
  if (directPackageJson) {
    return { packageName, packageJsonPath: directPackageJson, pkg: readJson(directPackageJson) }
  }
  try {
    const packageJsonPath = requireFromRoot.resolve(`${packageName}/package.json`)
    return { packageName, packageJsonPath, pkg: readJson(packageJsonPath) }
  } catch {
    try {
      const entry = requireFromRoot.resolve(packageName)
      const packageJsonPath = findPackageJsonAbove(entry)
      return { packageName, packageJsonPath, pkg: packageJsonPath ? readJson(packageJsonPath) : null }
    } catch {
      return { packageName, packageJsonPath: null, pkg: null }
    }
  }
}

function findPackageJsonInNodeModules(start, packageName) {
  let current = path.resolve(start)
  while (true) {
    const candidate = path.join(current, 'node_modules', packageName, 'package.json')
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate)
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function findPackageJsonAbove(start) {
  let current = fs.statSync(start).isDirectory() ? start : path.dirname(start)
  while (true) {
    const candidate = path.join(current, 'package.json')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function vitePeerSupports8(range) {
  if (!range) return null
  try {
    return semver.intersects(range, '8.x', { includePrerelease: true })
  } catch {
    return null
  }
}

function findSourceEvidence(source, index, needle = '') {
  const before = source.slice(0, index)
  const line = before.split(/\r?\n/).length
  const lineStart = before.lastIndexOf('\n') + 1
  const lineEnd = source.indexOf('\n', index)
  const snippet = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd).trim()
  return { line, snippet, match: needle }
}

function analyze(root) {
  const pkgPath = findUp(root, 'package.json')
  if (!pkgPath) {
    throw new Error(`No package.json found from ${root}`)
  }

  const projectRoot = path.dirname(pkgPath)
  const pkg = readJson(pkgPath)
  const deps = collectDeps(pkg)
  const packageManager = detectPackageManager(projectRoot, pkg)
  const projectShape = detectProjectShape(projectRoot)
  const configPath = findConfig(projectRoot)
  const configSource = configPath ? fs.readFileSync(configPath, 'utf8') : ''
  const pluginImports = configPath ? extractPluginImports(configSource) : []
  const ownVitePeerRange = pkg.peerDependencies?.vite ?? null

  const risks = []
  for (const pattern of RISK_PATTERNS) {
    const match = pattern.re.exec(configSource)
    if (match) {
      risks.push({
        id: pattern.id,
        level: pattern.level,
        message: pattern.message,
        evidence: configPath
          ? { file: configPath, ...findSourceEvidence(configSource, match.index, match[0]) }
          : null
      })
    }
  }

  const plugins = pluginImports.map(({ spec, evidence }) => {
    const installed = readInstalledPackage(projectRoot, spec)
    const peerRange = installed.pkg?.peerDependencies?.vite ?? null
    return {
      spec,
      packageName: installed.packageName,
      installedVersion: installed.pkg?.version ?? null,
      packageJsonPath: installed.packageJsonPath,
      vitePeerRange: peerRange,
      vite8PeerSupported: vitePeerSupports8(peerRange),
      evidence: configPath ? { file: configPath, ...evidence } : null
    }
  })

  return {
    projectRoot,
    packageName: pkg.name ?? null,
    packageManager,
    packageManagerRaw: pkg.packageManager ?? null,
    viteRange: deps.vite ?? null,
    ownVitePeerRange,
    ownVite8PeerSupported: vitePeerSupports8(ownVitePeerRange),
    configPath,
    projectShape,
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      packageManager,
      packageManagerRaw: pkg.packageManager ?? null,
      packageName: pkg.name ?? null,
      viteRange: deps.vite ?? null,
      ownVitePeerRange,
      projectRoot,
      configPath,
      projectShape: projectShape.kind
    },
    risks,
    plugins
  }
}

function runProbe(report, options) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vite8-doctor-'))
  const probe = {
    tempRoot,
    cleanup: options.keepTemp ? 'kept' : 'removed',
    current: null,
    vite8: null,
    classification: 'probe-inconclusive'
  }

  if (report.projectShape.kind === 'workspace-root' || report.projectShape.kind === 'workspace-child') {
    probe.classification = 'probe-inconclusive'
    probe.current = {
      ok: false,
      skipped: true,
      command: null,
      exitCode: null,
      signal: null,
      timedOut: false,
      output: `Probe mode does not support ${report.projectShape.kind} projects in 0.1.`,
      reason: report.projectShape.kind === 'workspace-root'
        ? 'unsupported-workspace-root'
        : 'unsupported-workspace-child',
      warnings: [],
      assets: emptyAssets()
    }
    cleanupTemp(tempRoot, options.keepTemp)
    return probe
  }

  const currentOutDir = path.join(tempRoot, 'current')
  const current = runViteBuild(report.projectRoot, currentOutDir, options.timeoutMs)
  probe.current = current

  if (!current.ok) {
    probe.classification = 'baseline-broken'
    cleanupTemp(tempRoot, options.keepTemp)
    return probe
  }

  if (!options.probeVite8) {
    probe.classification = hasFormalizedRisk(report)
      ? 'passed-with-risks'
      : 'passed'
    cleanupTemp(tempRoot, options.keepTemp)
    return probe
  }

  if (!options.allowInstall) {
    probe.classification = 'probe-inconclusive'
    probe.vite8 = {
      skipped: true,
      reason: 'Vite 8 comparison requires --allow-install because it installs dependencies inside a temporary project copy.'
    }
    cleanupTemp(tempRoot, options.keepTemp)
    return probe
  }

  const tempProjectRoot = path.join(tempRoot, 'project')
  copyProject(report.projectRoot, tempProjectRoot)
  const install = installVite8(tempProjectRoot, report.packageManager, options.timeoutMs)
  if (!install.ok) {
    probe.classification = 'probe-inconclusive'
    probe.vite8 = { install, build: null }
    cleanupTemp(tempRoot, options.keepTemp)
    return probe
  }

  const vite8OutDir = path.join(tempRoot, 'vite8')
  const build = runViteBuild(tempProjectRoot, vite8OutDir, options.timeoutMs)
  probe.vite8 = { install, build }
  if (probe.current?.assets && build.assets) {
    probe.assetDelta = diffAssets(probe.current, build)
  }
  probe.classification = build.ok
    ? hasFormalizedRisk(report)
      ? 'passed-with-risks'
      : 'passed'
    : 'vite8-build-failed'

  cleanupTemp(tempRoot, options.keepTemp)
  return probe
}

function runViteBuild(root, outDir, timeoutMs) {
  const command = viteCommand(root)
  if (!command) {
    return {
      ok: false,
      skipped: false,
      command: null,
      exitCode: null,
      signal: null,
      timedOut: false,
      output: 'Could not find a local vite binary or a supported package manager command.',
      warnings: [],
      assets: emptyAssets()
    }
  }

  const args = [...command.args, 'build', '--outDir', outDir, '--emptyOutDir', 'true']
  const result = runCommand(command.cmd, args, root, timeoutMs)
  return {
    ok: result.exitCode === 0,
    skipped: false,
    command: [command.cmd, ...args].join(' '),
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    output: trimOutput(result.output),
    warnings: extractWarnings(result.output),
    assets: summarizeAssets(outDir)
  }
}

function viteCommand(root) {
  const localBin = findLocalBin(root, 'vite')
  if (localBin) return { cmd: localBin, args: [] }
  const pkgPath = findUp(root, 'package.json')
  const pkg = pkgPath ? readJson(pkgPath) : {}
  const packageManager = detectPackageManager(pkgPath ? path.dirname(pkgPath) : root, pkg)
  if (packageManager === 'pnpm') return { cmd: 'pnpm', args: ['exec', 'vite'] }
  if (packageManager === 'yarn') return { cmd: 'yarn', args: ['vite'] }
  if (packageManager === 'npm') return { cmd: 'npm', args: ['exec', '--', 'vite'] }
  return null
}

function findLocalBin(start, name) {
  let current = path.resolve(start)
  while (true) {
    const candidate = path.join(current, 'node_modules', '.bin', name)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function installVite8(root, packageManager, timeoutMs) {
  const installCommand = packageManager === 'pnpm'
    ? { cmd: 'pnpm', args: ['install', '--ignore-scripts', '--no-frozen-lockfile'] }
    : packageManager === 'yarn'
      ? null
      : { cmd: 'npm', args: ['install', '--ignore-scripts'] }
  const addCommand = packageManager === 'pnpm'
    ? { cmd: 'pnpm', args: ['add', '-D', 'vite@8', '--ignore-scripts'] }
    : packageManager === 'yarn'
      ? null
      : { cmd: 'npm', args: ['install', '-D', 'vite@8', '--ignore-scripts'] }

  if (!installCommand || !addCommand) {
    return {
      ok: false,
      step: 'unsupported-package-manager',
      command: null,
      exitCode: null,
      signal: null,
      timedOut: false,
      output: 'Vite 8 comparison is disabled for Yarn in 0.1 because lifecycle-script suppression is not implemented safely.'
    }
  }

  const install = runCommand(installCommand.cmd, installCommand.args, root, timeoutMs)
  if (install.exitCode !== 0) {
    return {
      ok: false,
      step: 'install',
      command: [installCommand.cmd, ...installCommand.args].join(' '),
      exitCode: install.exitCode,
      signal: install.signal,
      timedOut: install.timedOut,
      output: trimOutput(install.output)
    }
  }

  const add = runCommand(addCommand.cmd, addCommand.args, root, timeoutMs)
  return {
    ok: add.exitCode === 0,
    step: 'add-vite8',
    command: [addCommand.cmd, ...addCommand.args].join(' '),
    exitCode: add.exitCode,
    signal: add.signal,
    timedOut: add.timedOut,
    output: trimOutput(add.output)
  }
}

function runCommand(cmd, args, cwd, timeoutMs) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    env: childEnv(),
    maxBuffer: 8 * 1024 * 1024,
    timeout: timeoutMs
  })
  const output = redactSensitiveOutput(`${result.stdout ?? ''}${result.stderr ?? ''}`)
  return {
    exitCode: result.status,
    signal: result.signal,
    timedOut: result.error?.code === 'ETIMEDOUT',
    output: result.error && !output ? result.error.message : output
  }
}

function childEnv() {
  const env = {}
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key]
  }
  env.CI = '1'
  return env
}

function redactSensitiveOutput(output) {
  let redacted = output
  for (const [key, value] of Object.entries(process.env)) {
    if (!SENSITIVE_ENV_RE.test(key) || !value || value.length < 6) continue
    redacted = redacted.split(value).join('[redacted]')
  }
  return redacted
}

function copyProject(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    filter(src) {
      const rel = path.relative(source, src)
      if (!rel) return true
      return !rel.split(path.sep).some(shouldExcludeCopyPart)
    }
  })
}

function shouldExcludeCopyPart(part) {
  return COPY_EXCLUDES.has(part) || part === '.env' || part.startsWith('.env.')
}

function cleanupTemp(tempRoot, keepTemp) {
  if (!keepTemp) fs.rmSync(tempRoot, { recursive: true, force: true })
}

function trimOutput(output) {
  if (output.length <= OUTPUT_LIMIT) return output.trim()
  return `${output.slice(0, OUTPUT_LIMIT).trim()}\n... output truncated ...`
}

function extractWarnings(output) {
  return output
    .split(/\r?\n/)
    .filter(line => /warning|\(!\)|warn/i.test(line))
    .slice(0, 20)
}

function summarizeAssets(outDir) {
  if (!fs.existsSync(outDir)) return emptyAssets()
  const files = []
  collectFiles(outDir, outDir, files)
  files.sort((a, b) => b.bytes - a.bytes)
  return {
    count: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    largest: files.slice(0, 10),
    files
  }
}

function emptyAssets() {
  return { count: 0, totalBytes: 0, largest: [], files: [] }
}

function collectFiles(baseDir, dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectFiles(baseDir, fullPath, files)
    } else if (entry.isFile()) {
      const stat = fs.statSync(fullPath)
      files.push({ file: path.relative(baseDir, fullPath), bytes: stat.size })
    }
  }
}

function diffAssets(currentBuild, vite8Build) {
  const current = currentBuild.assets
  const vite8 = vite8Build.assets
  const currentAssetFiles = current.files ?? current.largest
  const vite8AssetFiles = vite8.files ?? vite8.largest
  const currentByFile = new Map(currentAssetFiles.map(file => [file.file, file]))
  const vite8ByFile = new Map(vite8AssetFiles.map(file => [file.file, file]))
  const currentFiles = new Set(currentAssetFiles.map(file => file.file))
  const vite8Files = new Set(vite8AssetFiles.map(file => file.file))
  const added = [...vite8Files]
    .filter(file => !currentFiles.has(file))
    .sort()
    .map(file => vite8ByFile.get(file))
  const removed = [...currentFiles]
    .filter(file => !vite8Files.has(file))
    .sort()
    .map(file => currentByFile.get(file))
  const changed = [...currentFiles]
    .filter(file => vite8Files.has(file) && currentByFile.get(file).bytes !== vite8ByFile.get(file).bytes)
    .sort()
    .map(file => ({
      file,
      currentBytes: currentByFile.get(file).bytes,
      vite8Bytes: vite8ByFile.get(file).bytes,
      deltaBytes: vite8ByFile.get(file).bytes - currentByFile.get(file).bytes
    }))

  return {
    currentCount: current.count,
    vite8Count: vite8.count,
    countDelta: vite8.count - current.count,
    currentTotalBytes: current.totalBytes,
    vite8TotalBytes: vite8.totalBytes,
    totalBytesDelta: vite8.totalBytes - current.totalBytes,
    currentWarningCount: currentBuild.warnings.length,
    vite8WarningCount: vite8Build.warnings.length,
    warningCountDelta: vite8Build.warnings.length - currentBuild.warnings.length,
    largestCurrent: current.largest[0] ?? null,
    largestVite8: vite8.largest[0] ?? null,
    added: added.slice(0, 20),
    removed: removed.slice(0, 20),
    changed: changed.slice(0, 20)
  }
}

function generateMigrationHints(report) {
  const hints = []
  const hasRisk = (...ids) => report.risks.some(risk => ids.includes(risk.id))

  if (hasRisk('optimize-deps', 'optimize-deps-esbuild-options')) {
    hints.push({
      id: 'optimize-deps',
      title: 'Dependency optimizer config needs review',
      trigger: 'vite.config contains optimizeDeps customization',
      evidence: riskEvidence(report, 'optimize-deps', 'optimize-deps-esbuild-options'),
      sourceType: 'docs',
      sourceUrl: VITE_MIGRATION_DOC,
      disclaimer: 'Migration hint only; verify optimizer behavior in this project.',
      nextStep: 'Run the build probe and the project tests around dependencies that are optimized or excluded.'
    })
  }

  if (hasRisk('rollup-output-manual-chunks', 'rollup-options')) {
    hints.push({
      id: 'rollup-options',
      title: 'Chunking config may need review',
      trigger: 'vite.config contains rollupOptions or manualChunks',
      evidence: riskEvidence(report, 'rollup-output-manual-chunks', 'rollup-options'),
      sourceType: 'docs',
      sourceUrl: VITE_ROLLDOWN_DOC,
      disclaimer: 'Migration hint only; chunking differences are not a failure by themselves.',
      nextStep: 'Compare build output and inspect changed chunks before changing config.'
    })
  }

  for (const plugin of report.plugins.filter(plugin => plugin.vite8PeerSupported === false)) {
    hints.push({
      id: 'plugin-peer-metadata',
      title: `${plugin.spec} does not declare Vite 8 peer support`,
      trigger: 'installed plugin peerDependencies.vite excludes Vite 8',
      evidence: {
        packageJsonPath: plugin.packageJsonPath,
        vitePeerRange: plugin.vitePeerRange,
        spec: plugin.spec
      },
      sourceType: 'package-metadata',
      sourceUrl: null,
      disclaimer: 'Peer metadata can lag behind actual compatibility; this is not proof of breakage.',
      nextStep: 'Check the plugin release notes or run a focused build/test with the plugin enabled.'
    })
  }

  if (report.ownVitePeerRange && report.ownVite8PeerSupported === false) {
    hints.push({
      id: 'package-peer-metadata',
      title: 'This package does not declare Vite 8 peer support',
      trigger: 'package peerDependencies.vite excludes Vite 8',
      evidence: {
        packageName: report.packageName,
        vitePeerRange: report.ownVitePeerRange,
        projectRoot: report.projectRoot
      },
      sourceType: 'package-metadata',
      sourceUrl: null,
      disclaimer: 'Peer metadata can lag behind actual compatibility; this is not proof of breakage.',
      nextStep: 'Check whether this package has a Vite 8-compatible release or run its test suite against Vite 8.'
    })
  }

  if (report.projectShape.kind === 'workspace-root' || report.projectShape.kind === 'workspace-child') {
    hints.push({
      id: 'workspace-scope',
      title: 'Workspace probe scope is limited in 0.1',
      trigger: `project shape is ${report.projectShape.kind}`,
      evidence: report.projectShape,
      sourceType: 'tool-limitation',
      sourceUrl: null,
      disclaimer: '0.1 cannot safely probe partial workspace graphs.',
      nextStep: 'Run the static report at the workspace root and probe standalone packages separately.'
    })
  }

  if (report.probe?.classification === 'baseline-broken') {
    hints.push({
      id: 'baseline-broken',
      title: 'Current build already fails',
      trigger: 'current Vite build failed before Vite 8 comparison',
      evidence: {
        command: report.probe.current.command,
        exitCode: report.probe.current.exitCode
      },
      sourceType: 'local-build-output',
      sourceUrl: null,
      disclaimer: 'Fix the baseline before attributing failures to Vite 8.',
      nextStep: 'Repair the current build, then rerun with --probe-vite8 --allow-install.'
    })
  }

  if (report.probe?.vite8?.install?.step === 'unsupported-package-manager' && report.packageManager === 'yarn') {
    hints.push({
      id: 'yarn-vite8-comparison',
      title: 'Yarn Vite 8 comparison is disabled',
      trigger: 'Yarn project requested --probe-vite8 --allow-install',
      evidence: {
        packageManager: report.packageManager,
        output: report.probe.vite8.install.output
      },
      sourceType: 'tool-limitation',
      sourceUrl: null,
      disclaimer: 'Disabled until lifecycle-script suppression is implemented safely.',
      nextStep: 'Use the static report, or run an isolated manual Vite 8 branch for Yarn projects.'
    })
  }

  const largeChunkWarnings = collectBuildWarnings(report).filter(warning => LARGE_CHUNK_RE.test(warning))
  if (largeChunkWarnings.length) {
    hints.push({
      id: 'large-chunk-warning',
      title: 'Build output contains a large chunk warning',
      trigger: 'Vite emitted a chunk larger than 500 kB warning',
      evidence: { warnings: largeChunkWarnings.slice(0, 5) },
      sourceType: 'local-build-output',
      sourceUrl: null,
      disclaimer: 'Build output warning only; inspect chunking before changing config.',
      nextStep: 'Review the asset delta and decide whether manual chunking or lazy loading needs adjustment.'
    })
  }

  return hints
}

function hasFormalizedRisk(report) {
  return report.risks.some(risk => [
    'optimize-deps',
    'optimize-deps-esbuild-options',
    'rollup-output-manual-chunks',
    'rollup-options'
  ].includes(risk.id)) ||
    report.plugins.some(plugin => plugin.vite8PeerSupported === false) ||
    (report.ownVitePeerRange && report.ownVite8PeerSupported === false)
}

function riskEvidence(report, ...ids) {
  const risk = report.risks.find(candidate => ids.includes(candidate.id))
  return risk?.evidence ?? null
}

function collectBuildWarnings(report) {
  return [
    ...(report.probe?.current?.warnings ?? []),
    ...(report.probe?.vite8?.build?.warnings ?? [])
  ]
}

function renderMarkdown(report) {
  const lines = []
  lines.push(`# vite8-doctor report`)
  lines.push('')
  lines.push(`project: ${report.packageName ?? '(unnamed)'}`)
  lines.push(`root: ${report.projectRoot}`)
  lines.push(`node: ${report.environment.nodeVersion} (${report.environment.platform}/${report.environment.arch})`)
  lines.push(`package manager: ${report.packageManager ?? '(not declared)'}`)
  lines.push(`package manager raw: ${report.packageManagerRaw ?? '(not declared)'}`)
  lines.push(`vite range: ${report.viteRange ?? '(not found)'}`)
  lines.push(`config: ${report.configPath ?? '(not found)'}`)
  lines.push(`project shape: ${renderProjectShape(report.projectShape)}`)
  lines.push('')

  renderMigrationHints(lines, report.migrationHints ?? [])
  lines.push('')

  lines.push(`## config risks`)
  if (report.risks.length === 0) {
    lines.push('')
    lines.push('none detected')
  } else {
    for (const risk of report.risks) {
      lines.push(`- [${risk.level}] ${risk.id}: ${risk.message}`)
      if (risk.evidence) {
        lines.push(`  evidence: ${risk.evidence.file}:${risk.evidence.line} \`${risk.evidence.snippet}\``)
      }
    }
  }
  lines.push('')

  lines.push(`## plugin peer ranges`)
  if (report.plugins.length === 0) {
    lines.push('')
    lines.push('no Vite plugin imports detected')
  } else {
    for (const plugin of report.plugins) {
      const support =
        plugin.vite8PeerSupported === true
          ? 'supports vite 8'
          : plugin.vite8PeerSupported === false
            ? 'does not declare vite 8 support'
            : 'no vite peer range found'
      lines.push(
        `- ${plugin.spec}: ${plugin.installedVersion ?? 'not installed'}, peer vite ${plugin.vitePeerRange ?? '(none)'}; ${support}`
      )
      if (plugin.evidence) {
        lines.push(`  evidence: ${plugin.evidence.file}:${plugin.evidence.line} \`${plugin.evidence.snippet}\``)
      }
      if (plugin.vite8PeerSupported === false) {
        lines.push('  note: peer metadata can lag behind actual compatibility; this is a review signal, not proof of breakage.')
      }
    }
  }
  lines.push('')

  lines.push(`## next probe`)
  if (!report.probe) {
    lines.push('- run with `--probe-build` to execute the current Vite build into a temporary outDir')
    lines.push('- add `--probe-vite8 --allow-install` to compare against Vite 8 in a temporary project copy')
  } else {
    renderProbe(lines, report.probe)
  }

  return `${lines.join('\n')}\n`
}

function renderGitHubReport(report) {
  const lines = []
  lines.push(`## vite8-doctor report`)
  lines.push('')
  lines.push(`### Environment`)
  lines.push(`- package: ${report.packageName ?? '(unnamed)'}`)
  lines.push(`- root: ${report.projectRoot}`)
  lines.push(`- node: ${report.environment.nodeVersion}`)
  lines.push(`- platform: ${report.environment.platform}/${report.environment.arch}`)
  lines.push(`- package manager: ${report.packageManager ?? '(not declared)'} (${report.packageManagerRaw ?? 'no packageManager field'})`)
  lines.push(`- vite range: ${report.viteRange ?? '(not found)'}`)
  lines.push(`- config: ${report.configPath ?? '(not found)'}`)
  lines.push(`- project shape: ${renderProjectShape(report.projectShape)}`)
  lines.push('')

  lines.push(`### Summary`)
  lines.push(`- config risks: ${report.risks.length}`)
  lines.push(`- plugin peer issues: ${report.plugins.filter(plugin => plugin.vite8PeerSupported === false).length}`)
  lines.push(`- migration hints: ${(report.migrationHints ?? []).length}`)
  if (report.probe) lines.push(`- probe classification: ${report.probe.classification}`)
  lines.push('')

  renderMigrationHints(lines, report.migrationHints ?? [], '###')
  lines.push('')

  lines.push(`### Config risks`)
  if (report.risks.length === 0) {
    lines.push('- none detected')
  } else {
    for (const risk of report.risks) {
      lines.push(`- [${risk.level}] ${risk.id}: ${risk.message}`)
      if (risk.evidence) lines.push(`  - evidence: ${risk.evidence.file}:${risk.evidence.line} \`${risk.evidence.snippet}\``)
    }
  }
  lines.push('')

  lines.push(`### Plugin peer ranges`)
  if (report.plugins.length === 0) {
    lines.push('- no Vite plugin imports detected')
  } else {
    for (const plugin of report.plugins) {
      const support =
        plugin.vite8PeerSupported === true
          ? 'supports Vite 8'
          : plugin.vite8PeerSupported === false
            ? 'does not declare Vite 8 support'
            : 'no Vite peer range found'
      lines.push(`- ${plugin.spec}: ${plugin.installedVersion ?? 'not installed'}, peer vite ${plugin.vitePeerRange ?? '(none)'}; ${support}`)
    }
  }
  lines.push('')

  lines.push(`### Probe`)
  if (!report.probe) {
    lines.push('- not run')
  } else {
    renderProbe(lines, report.probe, '####')
  }

  return `${lines.join('\n')}\n`
}

function renderMigrationHints(lines, hints, heading = '##') {
  lines.push(`${heading} migration hints`)
  if (hints.length === 0) {
    lines.push('none detected')
    return
  }
  for (const hint of hints) {
    lines.push(`- ${hint.id}: ${hint.title}`)
    lines.push(`  trigger: ${hint.trigger}`)
    lines.push(`  source: ${renderHintSource(hint)}`)
    lines.push(`  evidence: ${formatHintEvidence(hint.evidence)}`)
    lines.push(`  note: ${hint.disclaimer}`)
    lines.push(`  next: ${hint.nextStep}`)
  }
}

function renderHintSource(hint) {
  if (hint.sourceUrl) return `${hint.sourceType} (${hint.sourceUrl})`
  return hint.sourceType
}

function formatHintEvidence(evidence) {
  if (!evidence) return '(none)'
  if (evidence.file) return `${evidence.file}:${evidence.line} \`${evidence.snippet}\``
  if (evidence.packageName && evidence.vitePeerRange) return `${evidence.packageName} peer vite ${evidence.vitePeerRange}`
  if (evidence.packageJsonPath) return `${evidence.spec} peer vite ${evidence.vitePeerRange} in ${evidence.packageJsonPath}`
  if (evidence.warnings) return evidence.warnings.join(' | ')
  if (evidence.command) return `${evidence.command} exited ${evidence.exitCode}`
  if (evidence.kind === 'workspace-root') return `workspace-root with ${evidence.childPackageCount} child package${evidence.childPackageCount === 1 ? '' : 's'}`
  if (evidence.kind === 'workspace-child') return `workspace-child under ${evidence.workspaceRoot}`
  if (evidence.packageManager) return `${evidence.packageManager}: ${oneLine(evidence.output ?? '')}`
  return oneLine(JSON.stringify(evidence))
}

function renderProbe(lines, probe, subheading = '###') {
  lines.push(`classification: ${probe.classification}`)
  lines.push(`temp: ${probe.cleanup === 'kept' ? probe.tempRoot : '(removed)'}`)
  lines.push('')
  lines.push(`${subheading} current build`)
  renderBuild(lines, probe.current)
  if (probe.vite8) {
    lines.push('')
    lines.push(`${subheading} vite 8 build`)
    if (probe.vite8.skipped) {
      lines.push(`skipped: ${probe.vite8.reason}`)
    } else {
      lines.push(`install: ${probe.vite8.install.ok ? 'passed' : 'failed'} (${probe.vite8.install.command})`)
      if (probe.vite8.install.output) lines.push(`install output: ${oneLine(probe.vite8.install.output)}`)
      if (probe.vite8.build) renderBuild(lines, probe.vite8.build)
    }
  }
  if (probe.assetDelta) {
    lines.push('')
    lines.push(`${subheading} build output delta`)
    renderAssetDelta(lines, probe.assetDelta)
  }
}

function renderBuild(lines, build) {
  lines.push(`status: ${build.ok ? 'passed' : 'failed'}`)
  if (build.skipped && build.reason) lines.push(`reason: ${build.reason}`)
  lines.push(`command: ${build.command ?? '(not available)'}`)
  lines.push(`exit: ${build.exitCode ?? '(none)'}${build.timedOut ? ' (timed out)' : ''}`)
  lines.push(`assets: ${build.assets.count} files, ${formatBytes(build.assets.totalBytes)}`)
  if (build.warnings.length) {
    lines.push('warnings:')
    for (const warning of build.warnings) lines.push(`- ${warning}`)
  }
  if (!build.ok && build.output) {
    lines.push('output:')
    lines.push('```')
    lines.push(build.output)
    lines.push('```')
  }
}

function renderAssetDelta(lines, delta) {
  lines.push(`assets: ${delta.currentCount} -> ${delta.vite8Count} (${signed(delta.countDelta)})`)
  lines.push(`total bytes: ${formatBytes(delta.currentTotalBytes)} -> ${formatBytes(delta.vite8TotalBytes)} (${signed(delta.totalBytesDelta)} B)`)
  lines.push(`warnings: ${delta.currentWarningCount} -> ${delta.vite8WarningCount} (${signed(delta.warningCountDelta)})`)
  if (delta.largestCurrent || delta.largestVite8) {
    lines.push(`largest current: ${renderAsset(delta.largestCurrent)}`)
    lines.push(`largest vite8: ${renderAsset(delta.largestVite8)}`)
  }
  if (delta.added.length) lines.push(`added: ${delta.added.map(renderAsset).join(', ')}`)
  if (delta.removed.length) lines.push(`removed: ${delta.removed.map(renderAsset).join(', ')}`)
  if (delta.changed.length) {
    lines.push(`changed: ${delta.changed.map(file => `${file.file} ${signed(file.deltaBytes)} B`).join(', ')}`)
  }
}

function renderAsset(asset) {
  if (!asset) return '(none)'
  return `${asset.file} (${formatBytes(asset.bytes)})`
}

function signed(value) {
  return value > 0 ? `+${value}` : `${value}`
}

function renderProjectShape(projectShape) {
  if (!projectShape) return 'unknown'
  if (projectShape.kind === 'workspace-root') {
    return `workspace-root (${projectShape.childPackageCount} child package${projectShape.childPackageCount === 1 ? '' : 's'} detected)`
  }
  if (projectShape.kind === 'workspace-child') {
    return `workspace-child (root: ${projectShape.workspaceRoot})`
  }
  return projectShape.kind
}

function oneLine(text) {
  return text.replace(/\s+/g, ' ').slice(0, 300)
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function parseArgs(args) {
  const options = {
    report: 'markdown',
    reportExplicit: false,
    help: false,
    probeBuild: false,
    probeVite8: false,
    allowInstall: false,
    keepTemp: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    target: null
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') {
      if (!options.reportExplicit) options.report = 'json'
    }
    else if (arg === '--report') {
      index += 1
      options.report = args[index]
      options.reportExplicit = true
    }
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--probe-build') options.probeBuild = true
    else if (arg === '--probe-vite8') options.probeVite8 = true
    else if (arg === '--allow-install') options.allowInstall = true
    else if (arg === '--keep-temp') options.keepTemp = true
    else if (arg === '--timeout-ms') {
      index += 1
      options.timeoutMs = Number(args[index])
    } else if (!arg.startsWith('-') && !options.target) {
      options.target = arg
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number')
  }
  if (!['markdown', 'json', 'github'].includes(options.report)) {
    throw new Error('--report must be one of: markdown, json, github')
  }
  delete options.reportExplicit

  return options
}

function renderHelp() {
  return `vite8-doctor

Usage:
  vite8-doctor [path] [--json|--report markdown|json|github]
  vite8-doctor [path] --probe-build [--probe-vite8 --allow-install]

Options:
  --json           Print JSON instead of markdown. Alias for --report json.
  --report FORMAT  Print markdown, json, or github. Default: markdown.
  --probe-build    Run the current Vite build into a temporary outDir.
  --probe-vite8    Also compare against Vite 8 in a temporary project copy.
  --allow-install  Allow dependency install only inside the temporary copy.
  --keep-temp      Keep temporary probe files for inspection.
  --timeout-ms N   Per-command timeout. Default: ${DEFAULT_TIMEOUT_MS}.
  --help           Show this help.
`
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(renderHelp())
    return
  }

  const root = options.target ? path.resolve(options.target) : process.cwd()
  const report = analyze(root)
  if (options.probeBuild) {
    report.probe = runProbe(report, options)
  }
  report.migrationHints = generateMigrationHints(report)

  if (options.report === 'json') {
    console.log(JSON.stringify(report, null, 2))
  } else if (options.report === 'github') {
    process.stdout.write(renderGitHubReport(report))
  } else {
    process.stdout.write(renderMarkdown(report))
  }
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
