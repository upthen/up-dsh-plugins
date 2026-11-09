import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const root = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'reading') : join(process.env.USERPROFILE || '.', '.dsh', 'reading')
try {
  const library = JSON.parse(await fs.readFile(join(root, 'library.json'), 'utf8'))
  console.log(`library: ${root}`)
  for (const book of library.books) {
    console.log(`- ${book.id} | ${book.title} | ${book.chapterCount} 章 | cover:${book.cover ? book.coverType || 'yes' : 'no'} | 进度 ${Math.round((book.progress?.percent || 0) * 100)}%`)
  }
  console.log(`settings: ${JSON.stringify(library.settings)}`)
  try {
    const notes = JSON.parse(await fs.readFile(join(root, 'notes.json'), 'utf8'))
    console.log(`notes: ${notes.notes.length}`)
  } catch {
    console.log('notes: none')
  }
} catch (error) {
  console.error(`cannot read library: ${error.message}`)
}
