import { promises as fs } from 'node:fs'
import { parseEpub } from '../host/epub.js'

const file = process.argv[2]
const limit = Number(process.argv[3] || 25)
const bytes = await fs.readFile(file)
const parsed = await parseEpub(bytes)
console.log(`title: ${parsed.meta.title}`)
console.log(`chapters: ${parsed.chapters.length}`)
const chapter = parsed.chapters[0]
console.log(`chapter 0: "${chapter.title}" blocks: ${chapter.blocks.length}`)
for (const [index, block] of chapter.blocks.slice(0, limit).entries()) {
  const text = (block.runs || []).map((run) => `${run.text}${run.ruby ? `(${run.ruby})` : ''}`).join('')
  const extra = block.t === 'img' ? ` src=${block.src}` : ''
  console.log(`${String(index).padStart(3)} ${block.t.padEnd(5)} ${JSON.stringify(text.slice(0, 70))}${extra}`)
}
