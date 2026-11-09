/**
 * Model-facing reading tools.
 *
 * These give the agent the same library the reader UI shows: browse the shelf,
 * read a chapter, search inside books, import from a host path, and manage notes.
 * Text output is bounded so a long classical text cannot flood the context.
 */
import { chapterPlainText } from './store.js'

const MAX_CHAPTER_CHARS = 20000
const MAX_SEARCH_RESULTS = 30

function textContent(text) {
  return [{ type: 'text', text }]
}

function textOutput(render) {
  return { schema: { type: 'object', properties: {} }, render }
}

function failure(code, message) {
  return Object.assign(new Error(message), { code })
}

/** Build the tool definitions bound to one library. */
export function createTools(library) {
  return [
    {
      name: 'reading_shelf',
      description:
        '列出「阅读」书架上的书籍：书名、作者、章节数与阅读进度。开始任何阅读相关任务前先调用它，获得书籍的 bookId。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: textOutput((_args, value) => textContent(value?.text || '书架为空。')),
      async execute() {
        await library.ensure()
        const { books } = library.snapshot()
        if (books.length === 0) return { text: '书架为空。用户可以先把 EPUB 导入「阅读」面板。' }
        const lines = books.map((book) => {
          const percent = Math.round((book.progress?.percent || 0) * 100)
          return `- bookId=${book.id} 《${book.title}》${book.author ? ` — ${book.author}` : ''}；${book.chapterCount} 章；进度 ${percent}%；上次读到第 ${(book.progress?.chapterIndex || 0) + 1} 章`
        })
        return { text: `书架共 ${books.length} 本：\n${lines.join('\n')}` }
      },
    },
    {
      name: 'reading_chapter',
      description:
        '读取一本书某一章的正文（纯文本）。不传 bookId 时使用最近阅读的书；不传 chapterIndex 时使用该书上次阅读的章节。内容较长时会截断并提示。',
      parameters: {
        type: 'object',
        properties: {
          bookId: { type: 'string', description: 'reading_shelf 返回的 bookId' },
          chapterIndex: { type: 'integer', description: '章节序号，从 0 开始' },
          offset: { type: 'integer', description: '从该字符位置开始读取，默认 0' },
        },
        additionalProperties: false,
      },
      output: textOutput((_args, value) => textContent(value?.text || '没有内容。')),
      async execute(args) {
        await library.ensure()
        const book = resolveBook(library, args?.bookId)
        const content = await library.readContent(book.id)
        if (content.chapters.length === 0) return { text: '这本书没有可读章节。' }
        const chapterIndex = clampIndex(args?.chapterIndex, book.progress?.chapterIndex, content.chapters.length)
        const chapter = content.chapters[chapterIndex]
        const plain = chapterPlainText(chapter)
        const offset = Math.max(0, Math.trunc(Number(args?.offset) || 0))
        const slice = plain.slice(offset, offset + MAX_CHAPTER_CHARS)
        const header = `《${book.title}》第 ${chapterIndex + 1}/${content.chapters.length} 章《${chapter.title}》\n\n`
        const footer =
          offset + MAX_CHAPTER_CHARS < plain.length
            ? `\n\n[已截断：本章共 ${plain.length} 字，可用 offset=${offset + MAX_CHAPTER_CHARS} 继续读取]`
            : ''
        return { text: header + slice + footer, bookId: book.id, chapterIndex, totalChars: plain.length }
      },
    },
    {
      name: 'reading_search',
      description: '在书架的一本书或全部书中检索关键词，返回章节与上下文片段。适合定位原文、查典故出处。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要查找的词句' },
          bookId: { type: 'string', description: '限定书籍；省略则搜索整个书架' },
          limit: { type: 'integer', description: `最多返回条数，默认 20，上限 ${MAX_SEARCH_RESULTS}` },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: textOutput((_args, value) => textContent(value?.text || '没有匹配。')),
      async execute(args) {
        await library.ensure()
        const query = String(args?.query || '').trim()
        if (!query) throw failure('reading/bad-request', 'query 不能为空')
        const results = await library.search(query, {
          bookId: typeof args?.bookId === 'string' ? args.bookId : undefined,
          limit: Math.min(MAX_SEARCH_RESULTS, Number(args?.limit) || 20),
        })
        if (results.length === 0) return { text: `没有找到「${query}」的匹配。` }
        const lines = results.map(
          (hit, index) =>
            `${index + 1}. 《${hit.bookTitle}》第 ${hit.chapterIndex + 1} 章《${hit.chapterTitle}》\n   ${hit.snippet}`,
        )
        return { text: `找到 ${results.length} 处匹配：\n${lines.join('\n')}`, results }
      },
    },
    {
      name: 'reading_import',
      description: '把 Host 上一个本地 EPUB 文件导入「阅读」书架（绝对路径）。用于用户要求导入书籍时。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'EPUB 文件的绝对路径' } },
        required: ['path'],
        additionalProperties: false,
      },
      output: textOutput((_args, value) => textContent(value?.text || '导入完成。')),
      async execute(args) {
        await library.ensure()
        const path = String(args?.path || '').trim()
        if (!path) throw failure('reading/bad-request', 'path 不能为空')
        const result = await library.importPath(path)
        return {
          text: `已导入《${result.book.title}》，共 ${result.book.chapterCount} 章（bookId=${result.book.id}）。${result.warnings?.length ? `\n提示：${result.warnings.join('；')}` : ''}`,
          book: result.book,
        }
      },
    },
    {
      name: 'reading_notes',
      description:
        '管理「阅读」笔记。action=list 列出笔记（可按 bookId 或 query 过滤）；action=save 新建或更新一条笔记；action=delete 删除一条笔记。笔记会显示在阅读面板的笔记页。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'save', 'delete'], description: '操作类型' },
          id: { type: 'string', description: 'save 时传入已有笔记 id 表示更新；delete 时必填' },
          bookId: { type: 'string', description: '关联书籍 id' },
          chapterIndex: { type: 'integer', description: '关联章节序号，从 0 开始' },
          chapterTitle: { type: 'string', description: '章节标题' },
          quote: { type: 'string', description: '原文选段' },
          question: { type: 'string', description: '用户的问题' },
          answer: { type: 'string', description: 'AI 回答或整理后的笔记正文（Markdown）' },
          note: { type: 'string', description: '用户补记' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签' },
          query: { type: 'string', description: 'list 时按关键词过滤' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: textOutput((_args, value) => textContent(value?.text || '完成。')),
      async execute(args) {
        await library.ensure()
        const action = String(args?.action || 'list')
        if (action === 'list') {
          const notes = library.listNotes({
            bookId: typeof args?.bookId === 'string' ? args.bookId : undefined,
            q: typeof args?.query === 'string' ? args.query : undefined,
          })
          if (notes.length === 0) return { text: '没有匹配的笔记。' }
          const lines = notes.map(
            (note, index) =>
              `${index + 1}. [${note.id}] 《${note.bookTitle}》第 ${note.chapterIndex + 1} 章《${note.chapterTitle}》\n   问：${(note.question || '').slice(0, 120)}\n   答：${(note.answer || '').slice(0, 200)}`,
          )
          return { text: `共 ${notes.length} 条笔记：\n${lines.join('\n')}`, notes }
        }
        if (action === 'delete') {
          const id = String(args?.id || '').trim()
          if (!id) throw failure('reading/bad-request', 'delete 需要 id')
          await library.deleteNote(id)
          return { text: `已删除笔记 ${id}。` }
        }
        if (action === 'save') {
          let bookId = typeof args?.bookId === 'string' ? args.bookId.trim() : ''
          let bookTitle = ''
          let chapterTitle = typeof args?.chapterTitle === 'string' ? args.chapterTitle : ''
          if (!bookId && typeof args?.id !== 'string') {
            const mostRecent = library.snapshot().books.sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0))[0]
            if (!mostRecent) throw failure('reading/bad-request', '书架为空，无法关联笔记')
            bookId = mostRecent.id
          }
          if (bookId) {
            const book = library.findBook(bookId)
            bookTitle = book.title
            if (!chapterTitle) {
              try {
                const content = await library.readContent(bookId)
                const index = clampIndex(args?.chapterIndex, book.progress?.chapterIndex, content.chapters.length)
                chapterTitle = content.chapters[index]?.title || ''
              } catch {
                chapterTitle = ''
              }
            }
          }
          const result = await library.saveNote({
            id: typeof args?.id === 'string' ? args.id : undefined,
            bookId,
            bookTitle,
            chapterIndex: Number.isInteger(args?.chapterIndex) ? args.chapterIndex : 0,
            chapterTitle,
            quote: typeof args?.quote === 'string' ? args.quote : '',
            question: typeof args?.question === 'string' ? args.question : '',
            answer: typeof args?.answer === 'string' ? args.answer : '',
            note: typeof args?.note === 'string' ? args.note : '',
            tags: Array.isArray(args?.tags) ? args.tags.filter((tag) => typeof tag === 'string') : [],
          })
          return {
            text: `已保存笔记（id=${result.note.id}）：《${result.note.bookTitle}》第 ${result.note.chapterIndex + 1} 章。`,
            note: result.note,
          }
        }
        throw failure('reading/bad-request', `未知 action：${action}`)
      },
    },
  ]
}

function resolveBook(library, bookId) {
  const id = typeof bookId === 'string' ? bookId.trim() : ''
  if (id) return library.findBook(id)
  const books = library.snapshot().books
  if (books.length === 0) throw failure('reading/empty-shelf', '书架为空，请先导入 EPUB')
  const sorted = [...books].sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0))
  return library.findBook(sorted[0].id)
}

function clampIndex(value, fallback, count) {
  const raw = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : Math.trunc(Number(fallback) || 0)
  return Math.min(Math.max(0, raw), Math.max(0, count - 1))
}
