import { promises as fs } from 'node:fs'
import { parseEpub } from '../host/epub.js'

const file = process.argv[2]
if (!file) {
  console.error('usage: node test/parse-file.mjs <book.epub>')
  process.exit(2)
}
const started = Date.now()
const bytes = await fs.readFile(file)
const parsed = await parseEpub(bytes)
const plain = parsed.chapters.map((chapter) =>
  chapter.blocks
    .map((block) => (block.runs ? block.runs.map((run) => run.text).join('') : block.t))
    .join('\n'),
)
const totalChars = plain.join('').length
console.log(
  JSON.stringify(
    {
      file,
      bytes: bytes.length,
      ms: Date.now() - started,
      meta: parsed.meta,
      cover: parsed.cover ? { path: parsed.cover.path, mediaType: parsed.cover.mediaType, bytes: parsed.cover.bytes.length } : null,
      chapters: parsed.chapters.length,
      assets: parsed.assets.length,
      totalChars,
      warnings: parsed.warnings,
      firstTitles: parsed.chapters.slice(0, 8).map((chapter) => chapter.title),
      sample: plain[0]?.slice(0, 200),
      blockTypes: [...new Set(parsed.chapters.flatMap((chapter) => chapter.blocks.map((block) => block.t)))],
    },
    null,
    2,
  ),
)
