/**
 * Unary RPC endpoints for the reading UI.
 *
 * The Client POSTs `{ endpoint, payload }` to the authenticated
 * `/api/reading/rpc` Fetch route, which dispatches here. Every endpoint
 * validates its own payload and returns plain JSON; failures carry a stable
 * machine-readable `code` so the UI can branch without parsing messages.
 */

/** Attach a stable error code to a thrown value. */
export function failure(code, message) {
  return Object.assign(new Error(message), { code })
}

/** Build the RPC handler bound to one library (and the optional ask service). */
export function createRpcHandler(library, options = {}) {
  return async function handleReadingRpc(endpoint, payload, signal) {
    await library.ensure()
    if (signal.aborted) return aborted()
    try {
      const value = await dispatch(endpoint, payload && typeof payload === 'object' ? payload : {}, signal)
      if (signal.aborted) return aborted()
      return { ok: true, value }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: typeof error?.code === 'string' ? error.code : 'reading/failed',
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
      }
    }
  }

  async function dispatch(endpoint, payload, signal) {
    switch (endpoint) {
      case 'ask/models': {
        if (!options.ask || typeof options.ask.listModels !== 'function') {
          throw failure('reading/no-ask', '对话服务不可用')
        }
        return { models: await options.ask.listModels(signal) }
      }
      case 'shelf':
        return library.snapshot()

      case 'book/open': {
        const id = requireString(payload.id, 'id')
        const book = library.findBook(id)
        const content = await library.readContent(id)
        return {
          book: { ...book },
          toc: content.chapters.map((chapter, index) => ({ index, title: chapter.title })),
          chapterIndex: clampChapter(book.progress?.chapterIndex, content.chapters.length),
          notes: library.listNotes({ bookId: id }),
        }
      }

      case 'book/chapter': {
        const id = requireString(payload.id, 'id')
        const content = await library.readContent(id)
        const chapterIndex = clampChapter(payload.chapterIndex, content.chapters.length)
        const chapter = content.chapters[chapterIndex]
        return {
          chapterIndex,
          chapterCount: content.chapters.length,
          chapter: { title: chapter.title, blocks: chapter.blocks },
          bookmarks: library.findBook(id).bookmarks.filter((bookmark) => bookmark.chapterIndex === chapterIndex),
        }
      }

      case 'book/open-mark': {
        const id = requireString(payload.id, 'id')
        const book = await library.markOpened(id, Number.isInteger(payload.chapterIndex) ? payload.chapterIndex : undefined)
        return { book }
      }

      case 'book/progress': {
        const id = requireString(payload.id, 'id')
        const book = await library.setProgress(id, payload)
        return { progress: book.progress }
      }

      case 'book/bookmark/add': {
        const id = requireString(payload.id, 'id')
        const book = await library.addBookmark(id, payload)
        return { bookmarks: book.bookmarks }
      }

      case 'book/bookmark/remove': {
        const id = requireString(payload.id, 'id')
        const bookmarkId = requireString(payload.bookmarkId, 'bookmarkId')
        const book = await library.removeBookmark(id, bookmarkId)
        return { bookmarks: book.bookmarks }
      }

      case 'book/delete': {
        const id = requireString(payload.id, 'id')
        await library.deleteBook(id)
        return { id, shelf: library.snapshot() }
      }

      case 'book/import-path': {
        const path = requireString(payload.path, 'path')
        const result = await library.importPath(path)
        return { ...result, shelf: library.snapshot() }
      }

      case 'search': {
        const q = requireString(payload.q, 'q')
        const results = await library.search(q, {
          bookId: typeof payload.bookId === 'string' ? payload.bookId : undefined,
          limit: payload.limit,
        })
        return { results }
      }

      case 'note/list':
        return { notes: library.listNotes({ bookId: payload.bookId, q: payload.q, tag: payload.tag }) }

      case 'note/save': {
        const input = payload.note && typeof payload.note === 'object' ? payload.note : payload
        const result = await library.saveNote(input)
        return { ...result, notes: library.listNotes() }
      }

      case 'note/delete': {
        const id = requireString(payload.id, 'id')
        await library.deleteNote(id)
        return { notes: library.listNotes() }
      }

      case 'note/export': {
        const notes = library.listNotes({ bookId: payload.bookId })
        return { markdown: renderNotesMarkdown(notes, library), count: notes.length }
      }

      case 'settings/save': {
        const settings = await library.updateSettings(payload.settings || payload)
        return { settings }
      }

      case 'conversation/prompt': {
        const id = requireString(payload.id, 'id')
        const book = library.findBook(id)
        const content = await library.readContent(id)
        const chapterIndex = clampChapter(payload.chapterIndex, content.chapters.length)
        const chapter = content.chapters[chapterIndex]
        return {
          prompt: renderConversationPrompt({
            book,
            chapter,
            chapterIndex,
            quote: typeof payload.quote === 'string' ? payload.quote : '',
            question: typeof payload.question === 'string' ? payload.question : '',
          }),
        }
      }

      default:
        throw failure('reading/unknown-endpoint', `unknown reading endpoint: ${endpoint}`)
    }
  }
}

function aborted() {
  return { ok: false, error: { code: 'reading/aborted', message: 'request cancelled', details: {} } }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw failure('reading/bad-request', `missing required field: ${field}`)
  }
  return value
}

function clampChapter(value, count) {
  const index = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0
  return Math.min(Math.max(0, index), Math.max(0, count - 1))
}

/** Compose the note document a user can download. */
export function renderNotesMarkdown(notes, library) {
  const byBook = new Map()
  for (const note of notes) {
    const key = note.bookId || 'unknown'
    if (!byBook.has(key)) byBook.set(key, [])
    byBook.get(key).push(note)
  }
  const lines = ['# 阅读笔记', '']
  for (const [bookId, bookNotes] of byBook) {
    const title = bookNotes[0].bookTitle || bookId
    lines.push(`## ${title}`, '')
    const sorted = [...bookNotes].sort((a, b) => a.chapterIndex - b.chapterIndex || a.createdAt - b.createdAt)
    for (const note of sorted) {
      lines.push(`### ${note.chapterTitle || `第 ${note.chapterIndex + 1} 章`}`, '')
      if (note.quote) {
        lines.push('> ' + note.quote.split('\n').join('\n> '), '')
      }
      if (note.question) lines.push(`**问**：${note.question}`, '')
      if (note.answer) lines.push(note.answer, '')
      if (note.note) lines.push(`**补记**：${note.note}`, '')
      lines.push('')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** Build the unsent user message for "continue in conversation". */
export function renderConversationPrompt({ book, chapter, chapterIndex, quote, question }) {
  const parts = [
    `我在读《${book.title}》的《${chapter.title}》（书架 bookId：${book.id}，第 ${chapterIndex + 1} 章）。`,
  ]
  if (quote) parts.push('', '选中的原文：', quote.split('\n').map((line) => `> ${line}`).join('\n'))
  if (question) parts.push('', `我的问题：${question}`)
  parts.push('', '请结合原文解答；需要更多上下文时，可以调用 reading_chapter 或 reading_search 工具查这本书。')
  return parts.join('\n')
}
