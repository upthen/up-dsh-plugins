#!/usr/bin/env node
/**
 * Preflight gate for the reading bundle.
 *
 * Run this BEFORE enabling the bundle in a live profile. The 2026-11-09 crash
 * happened because no test ever executed the plugin's `apply()`: an unusable API
 * call threw inside an async continuation, the unhandled rejection exited the
 * Host process, and DSH went down. Every check here is a cheap way to catch that
 * class of failure before it can take the app down.
 *
 *   node scripts/preflight.mjs
 */
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const node = process.execPath
const failures = []

function step(title, args) {
  process.stdout.write(`\n=== ${title} ===\n`)
  const result = spawnSync(node, args, { cwd: root, stdio: 'inherit', env: process.env })
  if (result.status !== 0) failures.push(title)
}

step('syntax: host entry', ['--check', 'index.js'])
step('syntax: host modules', ['--check', 'host/store.js'])
step('syntax: client source', ['--check', 'client-src/00-boot.js'])

// client.js is generated from client-src; rebuild it so the served bundle can
// never lag behind the sources.
step('build client bundle', ['scripts/build-client.mjs'])
step('syntax: built client bundle', ['--check', 'client.js'])

step('epub parser suite', ['test/epub.test.mjs'])
step('host library + tools suite', ['test/host-smoke.mjs'])
step('host route integration suite', ['test/routes-smoke.mjs'])
step('apply() smoke (the crash class)', ['test/apply-smoke.mjs'])
step('client wire smoke (fetch + SSE)', ['test/client-api-smoke.mjs'])
step('client bundle registration', ['test/client-bundle-smoke.mjs'])
step('headless render smoke', ['test/render-smoke.mjs'])

const packageJson = JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf8'))
const patch = await fs.readFile(join(root, 'cordis.patch.yml'), 'utf8')
if (!packageJson.dsh?.bundle?.patch) failures.push('manifest: dsh.bundle.patch missing')
if (!packageJson.dsh?.client) failures.push('manifest: dsh.client missing')
if (!patch.includes('id: reading')) failures.push('patch: reading row missing')

if (failures.length > 0) {
  console.error(`\n[preflight] FAILED: ${failures.join('; ')}`)
  console.error('[preflight] Do NOT enable the bundle in a live profile while this is red.')
  process.exit(1)
}
console.log('\n[preflight] all checks passed - safe to enable the bundle')
