import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const root = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'reading') : join(process.env.USERPROFILE || '.', '.dsh', 'reading')
const library = JSON.parse(await fs.readFile(join(root, 'library.json'), 'utf8'))

const normalize = (text) =>
  String(text || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[.·…]+$/g, '')
    .replace(/[\s\u3000]*\d+$/g, '')
    .replace(/[「」『』《》〈〉（）()\[\]【】<>:：;；,，.。!！?？'"“”‘’、·—–-]/g, '')
    .trim()

for (const book of library.books) {
  const content = JSON.parse(await fs.readFile(join(root, 'books', book.id, 'content.json'), 'utf8'))
  const titles = content.chapters.map((chapter) => normalize(chapter.title))
  let internal = 0
  let resolved = 0
  let external = 0
  const samples = []
  for (const [chapterIndex, chapter] of content.chapters.entries()) {
    for (const block of chapter.blocks) {
      for (const run of block.runs || []) {
        if (!run || typeof run.href !== 'string' || run.href.length === 0) continue
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(run.href)) {
          external += 1
          continue
        }
        internal += 1
        const target = normalize(run.text)
        let index = titles.indexOf(target)
        if (index < 0 && target.length >= 2) {
          index = titles.findIndex((title) => title.length >= 2 && (target.startsWith(title) || title.startsWith(target)))
        }
        if (index >= 0) resolved += 1
        if (samples.length < 4) samples.push({ chapterIndex, text: run.text, href: run.href, resolvedIndex: index })
      }
    }
  }
  console.log(`${book.title}: chapters=${content.chapters.length} internalLinks=${internal} resolvedByLabel=${resolved} external=${external}`)
  for (const sample of samples) console.log('   ', JSON.stringify(sample))
  const unresolved = []
  for (const [chapterIndex, chapter] of content.chapters.entries()) {
    for (const block of chapter.blocks) {
      for (const run of block.runs || []) {
        if (!run || typeof run.href !== 'string' || run.href.length === 0) continue
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(run.href)) continue
        const target = normalize(run.text)
        let index = titles.indexOf(target)
        if (index < 0 && target.length >= 2) {
          index = titles.findIndex((title) => title.length >= 2 && (target.startsWith(title) || title.startsWith(target)))
        }
        if (index < 0 && unresolved.length < 15) unresolved.push({ chapterIndex, text: run.text, href: run.href })
      }
    }
  }
  if (unresolved.length > 0) {
    console.log('   unresolved samples:')
    for (const sample of unresolved) console.log('     ', JSON.stringify(sample))
  }
}
