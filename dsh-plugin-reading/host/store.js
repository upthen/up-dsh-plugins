/**
 * Durable reading library on the Host filesystem.
 *
 * Layout under `libraryDir`:
 *   library.json                 shelf state, per-book progress and bookmarks, UI settings
 *   notes.json                   Q&A notes, one flat list
 *   books/<id>/meta.json         the imported book record
 *   books/<id>/content.json      normalized chapters (block model)
 *   books/<id>/cover.<ext>       cover image bytes
 *   books/<id>/assets/<name>     inline images referenced by chapters
 *   books/<id>/source/<name>     the original EPUB (kept for re-import/diagnostics)
 *
 * Every mutation rewrites one JSON document atomically (tmp file + rename) and is
 * serialized through a single write chain, so concurrent RPC calls and agent tools
 * cannot interleave a partial document.
 */
import { promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { parseEpub } from './epub.js'

const LIBRARY_VERSION = 1

/** Generate a short opaque identifier with a stable prefix. */
function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
}

/** Serialize JSON with two-space indentation and a trailing newline. */
function stringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** Write one file atomically inside an existing directory. */
async function writeAtomic(path, text) {
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, path)
}

/** Keep a relative member path inside `base`, rejecting traversal and absolute paths. */
function safeJoin(base, name) {
  const normalized = String(name).replaceAll('\\', '/')
  const target = resolve(base, normalized)
  const rel = relative(base, target)
  if (rel === '' || rel.startsWith('..') || resolve(base, rel) !== target) {
    throw new Error(`unsafe library path: ${name}`)
  }
  return target
}

/** Extract an extension from a media type or a member name, with a safe default. */
function extensionFor(mediaType, name) {
  const byType = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
  }
  if (byType[mediaType]) return byType[mediaType]
  const ext = extname(String(name)).toLowerCase()
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.bin'
}

/** Normalize one stored book record so readers never see missing fields. */
function normalizeBook(book) {
  return {
    id: book.id,
    title: book.title || 'Untitled',
    author: book.author || '',
    language: book.language || '',
    description: book.description || '',
    chapterCount: book.chapterCount || 0,
    cover: book.cover === true,
    coverType: book.coverType || '',
    bytes: book.bytes || 0,
    addedAt: book.addedAt || Date.now(),
    lastReadAt: book.lastReadAt || 0,
    openedCount: book.openedCount || 0,
    progress: book.progress || { chapterIndex: 0, scrollRatio: 0, percent: 0, updatedAt: 0 },
    bookmarks: Array.isArray(book.bookmarks) ? book.bookmarks : [],
  }
}

/** Normalize one stored note. */
function normalizeNote(note) {
  return {
    id: note.id,
    bookId: note.bookId || '',
    bookTitle: note.bookTitle || '',
    chapterIndex: Number.isInteger(note.chapterIndex) ? note.chapterIndex : 0,
    chapterTitle: note.chapterTitle || '',
    quote: note.quote || '',
    question: note.question || '',
    answer: note.answer || '',
    note: note.note || '',
    tags: Array.isArray(note.tags) ? note.tags : [],
    createdAt: note.createdAt || Date.now(),
    updatedAt: note.updatedAt || Date.now(),
  }
}

export const DEFAULT_SETTINGS = Object.freeze({
  fontSize: 19,
  lineHeight: 1.9,
  fontFamily: 'serif',
  theme: 'paper',
  contentWidth: 720,
  lastBookId: null,
})

/** One reading library rooted at a directory. */
export class Library {
  constructor(root) {
    this.root = resolve(root)
    this.libraryPath = join(this.root, 'library.json')
    this.notesPath = join(this.root, 'notes.json')
    this.booksDir = join(this.root, 'books')
    this.state = null
    this.notes = []
    this.ready = null
    this.writeChain = Promise.resolve()
    this.contentCache = new Map()
  }

  /** Create directories and load both documents exactly once. */
  ensure() {
    this.ready ??= (async () => {
      await fs.mkdir(this.booksDir, { recursive: true })
      this.state = await this.readLibrary()
      this.notes = await this.readNotes()
      return this
    })()
    return this.ready
  }

  async readLibrary() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.libraryPath, 'utf8'))
      return {
        version: LIBRARY_VERSION,
        books: (Array.isArray(parsed.books) ? parsed.books : []).map(normalizeBook),
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return { version: LIBRARY_VERSION, books: [], settings: { ...DEFAULT_SETTINGS } }
      }
      throw error
    }
  }

  async readNotes() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.notesPath, 'utf8'))
      return (Array.isArray(parsed.notes) ? parsed.notes : []).map(normalizeNote)
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
  }

  /** Serialize one mutation behind every earlier mutation. */
  async mutate(operation) {
    const run = this.writeChain.then(operation, operation)
    this.writeChain = run.catch(() => undefined)
    return run
  }

  async saveLibrary() {
    await writeAtomic(this.libraryPath, stringify(this.state))
  }

  async saveNotes() {
    await writeAtomic(this.notesPath, stringify({ version: LIBRARY_VERSION, notes: this.notes }))
  }

  /** Public shelf snapshot: books without internal paths plus settings. */
  snapshot() {
    return {
      books: this.state.books.map((book) => ({ ...book })),
      settings: { ...this.state.settings },
      notesCount: this.notes.length,
      libraryDir: this.root,
    }
  }

  findBook(id) {
    const book = this.state.books.find((candidate) => candidate.id === id)
    if (!book) throw Object.assign(new Error(`book not found: ${id}`), { code: 'reading/book-not-found' })
    return book
  }

  bookDir(id) {
    return join(this.booksDir, this.findBook(id).id)
  }

  contentPath(id) {
    return join(this.booksDir, this.findBook(id).id, 'content.json')
  }

  /** Read one book's normalized content, caching the most recently used book. */
  async readContent(id) {
    const book = this.findBook(id)
    const cached = this.contentCache.get(id)
    if (cached) return cached
    const content = JSON.parse(await fs.readFile(this.contentPath(id), 'utf8'))
    content.meta = { ...content.meta, ...pick(book, ['title', 'author', 'language']) }
    this.contentCache.set(id, content)
    if (this.contentCache.size > 2) {
      const oldest = this.contentCache.keys().next().value
      if (oldest !== undefined && oldest !== id) this.contentCache.delete(oldest)
    }
    return content
  }

  /** Import one EPUB buffer and persist every derived artifact. */
  async importEpub(buffer, fileName) {
    return this.mutate(async () => {
      const parsed = await parseEpub(buffer, {})
      const id = makeId('b')
      const dir = join(this.booksDir, id)
      const assetsDir = join(dir, 'assets')
      const sourceDir = join(dir, 'source')
      await fs.mkdir(assetsDir, { recursive: true })
      await fs.mkdir(sourceDir, { recursive: true })

      // Persist inline images under content-addressed names and rewrite block sources.
      const assetNames = new Map()
      for (const asset of parsed.assets) {
        const digest = createHash('sha1').update(asset.path).digest('hex').slice(0, 16)
        const name = `${digest}${extensionFor(asset.mediaType, asset.path)}`
        assetNames.set(asset.path, name)
        await fs.writeFile(join(assetsDir, name), asset.bytes)
      }
      for (const chapter of parsed.chapters) {
        for (const block of chapter.blocks) {
          if (block.t === 'img' && assetNames.has(block.src)) block.src = assetNames.get(block.src)
        }
      }

      let cover = false
      let coverType = ''
      if (parsed.cover) {
        coverType = parsed.cover.mediaType
        await fs.writeFile(join(dir, `cover${extensionFor(parsed.cover.mediaType, parsed.cover.path)}`), parsed.cover.bytes)
        cover = true
      }

      const sourceName = sanitizeFileName(fileName || `${parsed.meta.title || 'book'}.epub`)
      await fs.writeFile(join(sourceDir, sourceName), buffer)
      await fs.writeFile(
        join(dir, 'content.json'),
        stringify({ version: 1, chapters: parsed.chapters, toc: parsed.chapters.map((chapter, index) => ({ index, title: chapter.title })) }),
      )

      const record = normalizeBook({
        id,
        ...parsed.meta,
        // Gutenberg-style sources ship their banner in dc:title; keep the shelf clean.
        title: String(parsed.meta.title || '').replace(/^the project gutenberg ebook of\s*/i, '').trim() || parsed.meta.title,
        chapterCount: parsed.chapters.length,
        cover,
        coverType,
        bytes: buffer.byteLength,
        addedAt: Date.now(),
      })
      await fs.writeFile(join(dir, 'meta.json'), stringify(record))
      this.state.books.push(record)
      await this.saveLibrary()
      return { book: { ...record }, warnings: parsed.warnings }
    })
  }

  /** Import a book from an absolute path already on the Host. */
  async importPath(filePath) {
    const bytes = await fs.readFile(filePath)
    return this.importEpub(bytes, filePath.split(/[\\/]/).pop() || 'book.epub')
  }

  async deleteBook(id) {
    return this.mutate(async () => {
      const book = this.findBook(id)
      this.state.books = this.state.books.filter((candidate) => candidate.id !== id)
      this.notes = this.notes.filter((note) => note.bookId !== id)
      this.contentCache.delete(id)
      await fs.rm(join(this.booksDir, book.id), { recursive: true, force: true })
      await this.saveLibrary()
      await this.saveNotes()
      return true
    })
  }

  /** Update one book record through a mutator, then persist. */
  async updateBook(id, mutate) {
    return this.mutate(async () => {
      const book = this.findBook(id)
      mutate(book)
      await this.saveLibrary()
      return { ...book }
    })
  }

  async setProgress(id, input) {
    return this.updateBook(id, (book) => {
      const chapterIndex = Math.max(0, Math.trunc(Number(input.chapterIndex) || 0))
      const scrollRatio = clamp01(Number(input.scrollRatio) || 0)
      const percent = clamp01(Number(input.percent) || 0)
      book.progress = { chapterIndex, scrollRatio, percent, updatedAt: Date.now() }
      book.lastReadAt = Date.now()
    })
  }

  async markOpened(id, chapterIndex) {
    return this.updateBook(id, (book) => {
      book.openedCount = (book.openedCount || 0) + 1
      book.lastReadAt = Date.now()
      if (Number.isInteger(chapterIndex)) book.progress = { ...book.progress, chapterIndex }
      this.state.settings.lastBookId = id
    })
  }

  async addBookmark(id, input) {
    return this.updateBook(id, (book) => {
      const bookmark = {
        id: makeId('bm'),
        chapterIndex: Math.max(0, Math.trunc(Number(input.chapterIndex) || 0)),
        scrollRatio: clamp01(Number(input.scrollRatio) || 0),
        quote: String(input.quote || '').slice(0, 400),
        label: String(input.label || '').slice(0, 120),
        chapterTitle: String(input.chapterTitle || '').slice(0, 200),
        createdAt: Date.now(),
      }
      book.bookmarks = [bookmark, ...book.bookmarks].slice(0, 200)
    })
  }

  async removeBookmark(id, bookmarkId) {
    return this.updateBook(id, (book) => {
      book.bookmarks = book.bookmarks.filter((bookmark) => bookmark.id !== bookmarkId)
    })
  }

  async updateSettings(patch) {
    return this.mutate(async () => {
      this.state.settings = { ...this.state.settings, ...pickSettings(patch) }
      await this.saveLibrary()
      return { ...this.state.settings }
    })
  }

  async saveNote(input) {
    return this.mutate(async () => {
      const now = Date.now()
      const existing = input.id ? this.notes.find((note) => note.id === input.id) : undefined
      if (existing) {
        Object.assign(existing, normalizeNote({ ...existing, ...input, updatedAt: now }))
        await this.saveNotes()
        return { note: { ...existing } }
      }
      const note = normalizeNote({ ...input, id: makeId('n'), createdAt: now, updatedAt: now })
      this.notes.unshift(note)
      await this.saveNotes()
      return { note: { ...note } }
    })
  }

  async deleteNote(id) {
    return this.mutate(async () => {
      this.notes = this.notes.filter((note) => note.id !== id)
      await this.saveNotes()
      return true
    })
  }

  listNotes(query = {}) {
    let notes = this.notes
    if (query.bookId) notes = notes.filter((note) => note.bookId === query.bookId)
    if (query.tag) notes = notes.filter((note) => note.tags.includes(query.tag))
    if (query.q) {
      const needle = String(query.q).toLowerCase()
      notes = notes.filter((note) =>
        [note.quote, note.question, note.answer, note.note, note.bookTitle, note.chapterTitle]
          .some((field) => String(field || '').toLowerCase().includes(needle)))
    }
    return notes.map((note) => ({ ...note }))
  }

  /** Search chapter text across one book or the whole shelf. */
  async search(query, options = {}) {
    const needle = String(query || '').trim()
    if (!needle) return []
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(options.limit) || 20)))
    const books = options.bookId
      ? this.state.books.filter((book) => book.id === options.bookId)
      : this.state.books
    const results = []
    for (const book of books) {
      let content
      try {
        content = await this.readContent(book.id)
      } catch {
        continue
      }
      for (let index = 0; index < content.chapters.length && results.length < limit; index += 1) {
        const chapter = content.chapters[index]
        const plain = chapterPlainText(chapter)
        const at = plain.toLowerCase().indexOf(needle.toLowerCase())
        if (at < 0) continue
        const from = Math.max(0, at - 60)
        const to = Math.min(plain.length, at + needle.length + 80)
        results.push({
          bookId: book.id,
          bookTitle: book.title,
          chapterIndex: index,
          chapterTitle: chapter.title,
          snippet: `${from > 0 ? '…' : ''}${plain.slice(from, to)}${to < plain.length ? '…' : ''}`,
        })
      }
      if (results.length >= limit) break
    }
    return results
  }
}

/** Validate and clamp a library settings patch. */
function pickSettings(patch) {
  const out = {}
  if (patch && typeof patch === 'object') {
    if (Number.isFinite(Number(patch.fontSize))) out.fontSize = Math.min(40, Math.max(13, Math.trunc(Number(patch.fontSize))))
    if (Number.isFinite(Number(patch.lineHeight))) out.lineHeight = Math.min(3, Math.max(1.2, Number(patch.lineHeight)))
    if (Number.isFinite(Number(patch.contentWidth))) out.contentWidth = Math.min(1200, Math.max(420, Math.trunc(Number(patch.contentWidth))))
    if (typeof patch.fontFamily === 'string' && ['serif', 'sans', 'kai', 'song'].includes(patch.fontFamily)) out.fontFamily = patch.fontFamily
    if (typeof patch.theme === 'string' && ['paper', 'app', 'dark-paper'].includes(patch.theme)) out.theme = patch.theme
    if (patch.lastBookId === null || typeof patch.lastBookId === 'string') out.lastBookId = patch.lastBookId
  }
  return out
}

function sanitizeFileName(name) {
  const base = String(name || 'book.epub').replace(/[\\/:*?"<>|]/g, '_').slice(-120)
  return base || 'book.epub'
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
}

function pick(source, keys) {
  const out = {}
  for (const key of keys) out[key] = source[key]
  return out
}

/** Flatten one chapter's blocks into searchable plain text. */
export function chapterPlainText(chapter) {
  const parts = []
  const walk = (blocks) => {
    for (const block of blocks || []) {
      if (block.runs) parts.push(block.runs.map((run) => run.text).join(''))
      else if (block.t === 'quote' && block.blocks) walk(block.blocks)
      else if (block.t === 'list') {
        for (const item of block.items) parts.push(item.map((run) => run.text).join(''))
      } else if (block.t === 'img' && block.alt) parts.push(block.alt)
    }
  }
  walk(chapter.blocks)
  return parts.filter(Boolean).join('\n')
}

export { safeJoin }
