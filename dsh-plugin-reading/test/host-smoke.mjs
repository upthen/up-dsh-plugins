/**
 * Host-side smoke test for the reading library, RPC surface and tools.
 *
 *   node test/host-smoke.mjs
 *
 * Uses the generated sample EPUB in test/ (run scripts/make-sample-epub.mjs first).
 * The test never touches the real $DSH_HOME library: it opens a temp directory.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strict as assert } from 'node:assert'
import { Library } from '../host/store.js'
import { createRpcHandler } from '../host/rpc.js'
import { createTools } from '../host/tools.js'

const here = dirname(fileURLToPath(import.meta.url))
let passed = 0
function ok(name) {
  passed += 1
  console.log(`ok - ${name}`)
}

const root = await fs.mkdtemp(join(tmpdir(), 'reading-smoke-'))
const library = new Library(join(root, 'library'))
await library.ensure()
ok('library initialises empty directory')

const epubBytes = await fs.readFile(join(here, 'sample-lunyu.epub'))
const imported = await library.importEpub(epubBytes, 'sample-lunyu.epub')
assert.equal(imported.book.title, '論語', 'title parsed')
assert.ok(imported.book.chapterCount >= 3, 'chapters parsed')
assert.equal(imported.book.cover, true, 'cover detected')
ok(`imports sample EPUB (${imported.book.chapterCount} chapters, ${imported.warnings.length} warnings)`)

const shelf = library.snapshot()
assert.equal(shelf.books.length, 1)
assert.equal(shelf.books[0].id, imported.book.id)
ok('shelf lists the imported book')

const content = await library.readContent(imported.book.id)
assert.ok(content.chapters.length >= 3)
assert.ok(content.chapters.some((chapter) => /學而時習之/.test(JSON.stringify(chapter.blocks))), 'chapter text present')
const figure = content.chapters.some((chapter) => chapter.blocks.some((block) => block.t === 'img'))
assert.ok(figure, 'inline image block preserved')
ok('content chapters and inline images read back')

await library.setProgress(imported.book.id, { chapterIndex: 1, scrollRatio: 0.4, percent: 0.5 })
const progress = library.findBook(imported.book.id).progress
assert.equal(progress.chapterIndex, 1)
assert.ok(Math.abs(progress.percent - 0.5) < 1e-9)
ok('reading progress persists')

const bookmarked = await library.addBookmark(imported.book.id, {
  chapterIndex: 1,
  scrollRatio: 0.25,
  quote: '為政以德',
  chapterTitle: '为政篇第二',
})
assert.equal(bookmarked.bookmarks.length, 1)
const unbookmarked = await library.removeBookmark(imported.book.id, bookmarked.bookmarks[0].id)
assert.equal(unbookmarked.bookmarks.length, 0)
ok('bookmarks add and remove')

const savedNote = await library.saveNote({
  bookId: imported.book.id,
  bookTitle: '論語',
  chapterIndex: 0,
  chapterTitle: '学而篇第一',
  quote: '學而時習之，不亦說乎？',
  question: '这句话怎么理解？',
  answer: '学习并按时温习，内心喜悦。',
  tags: ['学而'],
})
assert.ok(savedNote.note.id.startsWith('n_'))
assert.equal(library.listNotes().length, 1)
ok('notes save and list')

const search = await library.search('為政以德')
assert.ok(search.length >= 1, 'search finds text')
assert.equal(search[0].bookId, imported.book.id)
ok('full-text search across chapters')

const rpc = createRpcHandler(library)
const shelfResponse = await rpc('shelf', {}, new AbortController().signal)
assert.equal(shelfResponse.ok, true)
assert.equal(shelfResponse.value.books.length, 1)
ok('rpc shelf')

const opened = await rpc('book/open', { id: imported.book.id }, new AbortController().signal)
assert.equal(opened.ok, true)
assert.ok(opened.value.toc.length >= 3)
assert.equal(opened.value.chapterIndex, 1, 'opens the saved chapter')
ok('rpc book/open resumes the saved chapter')

const chapter = await rpc('book/chapter', { id: imported.book.id, chapterIndex: 1 }, new AbortController().signal)
assert.equal(chapter.ok, true)
assert.ok(chapter.value.chapter.blocks.length > 0)
ok('rpc book/chapter')

const prompt = await rpc(
  'conversation/prompt',
  { id: imported.book.id, chapterIndex: 0, quote: '學而時習之', question: '如何理解？' },
  new AbortController().signal,
)
assert.equal(prompt.ok, true)
assert.ok(prompt.value.prompt.includes('論語'))
assert.ok(prompt.value.prompt.includes('學而時習之'))
ok('rpc conversation/prompt composes the handoff message')

const markdown = await rpc('note/export', {}, new AbortController().signal)
assert.equal(markdown.ok, true)
assert.ok(markdown.value.markdown.includes('阅读笔记'))
ok('rpc note/export renders Markdown')

const unknown = await rpc('does/not/exist', {}, new AbortController().signal)
assert.equal(unknown.ok, false)
assert.equal(unknown.error.code, 'reading/unknown-endpoint')
ok('rpc rejects unknown endpoints with a coded failure')

const tools = createTools(library)
const shelfTool = tools.find((tool) => tool.name === 'reading_shelf')
const shelfValue = await shelfTool.execute({}, {})
assert.ok(shelfValue.text.includes('論語'))
const chapterTool = tools.find((tool) => tool.name === 'reading_chapter')
const chapterValue = await chapterTool.execute({ bookId: imported.book.id, chapterIndex: 0 }, {})
assert.ok(chapterValue.text.includes('學而'))
const searchTool = tools.find((tool) => tool.name === 'reading_search')
const searchValue = await searchTool.execute({ query: '朝聞道' }, {})
assert.ok(searchValue.text.includes('朝聞道'))
const notesTool = tools.find((tool) => tool.name === 'reading_notes')
const notesValue = await notesTool.execute({ action: 'list' }, {})
assert.ok(notesValue.text.includes('共 1 条笔记'))
ok('agent tools read the shelf, chapters, search and notes')

await library.deleteBook(imported.book.id)
assert.equal(library.snapshot().books.length, 0)
assert.equal(library.listNotes().length, 0)
ok('deleting a book removes its notes and files')

await fs.rm(root, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)
