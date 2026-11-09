#!/usr/bin/env node
/**
 * Read-only helper for inspecting the packaged Harness: list entries or extract a
 * file out of an Electron asar archive with plain Node (no Electron fs patches).
 *
 *   node scripts/asar-extract.mjs list <archive> [substring]
 *   node scripts/asar-extract.mjs cat  <archive> <internal/path>
 *   node scripts/asar-extract.mjs grep <archive> <needle> [pathFilter] [--max-bytes N]
 *
 * Header layout (Chromium pickle): u32 pickle size, u32 JSON string size,
 * u32 actual JSON length, u32 padding, then the JSON at offset 16; file data
 * begins at 8 + pickle size.
 */
import { promises as fs } from 'node:fs'

const [action, archivePath, ...rest] = process.argv.slice(2)
if (!action || !archivePath) {
  console.error('usage: asar-extract.mjs <list|cat|grep> <archive> [arg]')
  process.exit(2)
}

const fd = await fs.open(archivePath, 'r')
const head = Buffer.alloc(16)
await fd.read(head, 0, 16, 0)
const headerPickleSize = head.readUInt32LE(4)
const jsonLength = head.readUInt32LE(12)
const jsonBytes = Buffer.alloc(jsonLength)
await fd.read(jsonBytes, 0, jsonLength, 16)
const header = JSON.parse(jsonBytes.toString('utf8'))
const baseOffset = 8 + headerPickleSize

function* walk(node, prefix = '') {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const path = prefix ? `${prefix}/${name}` : name
    if (entry.files) yield* walk(entry, path)
    else if (Number.isFinite(Number(entry.offset))) yield { path, offset: Number(entry.offset), size: Number(entry.size) }
  }
}

async function readEntry(entry) {
  const buffer = Buffer.alloc(entry.size)
  await fd.read(buffer, 0, buffer.length, baseOffset + entry.offset)
  return buffer
}

const entries = [...walk(header)]
if (action === 'list') {
  const needle = rest[0]
  for (const entry of entries) {
    if (!needle || entry.path.includes(needle)) console.log(entry.path)
  }
} else if (action === 'cat') {
  const target = entries.find((entry) => entry.path === rest[0])
  if (!target) {
    console.error(`not found: ${rest[0]}`)
    process.exit(1)
  }
  process.stdout.write(await readEntry(target))
} else if (action === 'grep') {
  const needle = rest[0]
  const maxIndex = rest.indexOf('--max-bytes')
  const maxBytes = maxIndex >= 0 ? Number(rest[maxIndex + 1]) : 2000
  const filter = rest[1] && !rest[1].startsWith('--') ? rest[1] : ''
  let hits = 0
  for (const entry of entries) {
    if (!entry.path.endsWith('.js') || (filter && !entry.path.includes(filter))) continue
    const text = (await readEntry(entry)).toString('utf8')
    let index = text.indexOf(needle)
    if (index < 0) continue
    hits += 1
    console.log(`\n===== ${entry.path} =====`)
    let count = 0
    while (index >= 0 && count < 6) {
      const from = Math.max(0, index - 200)
      console.log(`--- @${index} ---\n${text.slice(from, index + maxBytes)}`)
      index = text.indexOf(needle, index + needle.length)
      count += 1
    }
  }
  console.error(`[${hits} file(s) matched]`)
} else {
  console.error(`unknown action: ${action}`)
  process.exit(2)
}
await fd.close()
