/**
 * Reading page state.
 *
 * One external store owns the shelf, the open book, the selection/ask session and
 * the notes list; every view subscribes through `useReading()` and mutates through
 * `readingActions`. Host calls live here, so views stay presentational.
 */

/** The one live store; assigned by `createReadingStore`. */
let READING_STORE = null
/** The one live action set; assigned by `createReadingStore`. */
let READING_ACTIONS = null
/** The one live wire helper set; assigned by `createReadingStore`. */
let READING_API = null

const INITIAL_STATE = {
  status: 'loading',
  error: null,
  view: 'shelf',
  shelf: { books: [], settings: {}, notesCount: 0, libraryDir: '' },
  importing: false,
  current: null,
  loadingBook: false,
  reading: { tocOpen: false, notesOpen: false, settingsOpen: false },
  progress: { chapterIndex: 0, scrollRatio: 0, percent: 0 },
  selection: null,
  ask: {
    // Persistent reader conversation: one message list, streamed answer into the
    // trailing assistant message. The right-hand chat pane is always visible.
    messages: [],
    // A selection parked for "自己提问": the composer sends it with the next text.
    draftQuote: null,
    streaming: false,
    // Model picker state: directory cache and the chosen route (null = default).
    models: null,
    modelsLoading: false,
    modelsError: null,
    selection: null,
    activeModel: null,
  },
  notes: [],
  notesLoading: false,
  search: { open: false, q: '', loading: false, results: [] },
  toast: null,
}

/** Subscribe one component to the reading store. */
function useReading() {
  if (!READING_STORE) throw new Error('reading store is not initialised')
  return useStore(READING_STORE)
}

/** Download a text file the browser owns (notes export). */
function downloadText(fileName, text, mediaType = 'text/markdown;charset=utf-8') {
  const blob = new Blob([text], { type: mediaType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/** Create the store, actions and wire helpers for one Client plugin instance. */
function createReadingStore(ctx) {
  const store = createStore({ ...INITIAL_STATE, shelf: { ...INITIAL_STATE.shelf }, reading: { ...INITIAL_STATE.reading } })
  const api = createReadingApi(ctx)
  const set = store.set
  const get = store.get
  let bootstrapped = false
  let askAbort = null
  let pendingImportAbort = null

  // The model choice survives a page refresh: it is optional UI state, so a plain
  // localStorage slot is enough and failures are ignored.
  const ASK_MODEL_KEY = 'dsh.reading.askModel'
  function readStoredAskModel() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(ASK_MODEL_KEY) : null
      if (!raw) return null
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed.provider === 'string' && typeof parsed.model === 'string') {
        return {
          provider: parsed.provider,
          model: parsed.model,
          ...(typeof parsed.reasoningEffort === 'string' && parsed.reasoningEffort
            ? { reasoningEffort: parsed.reasoningEffort }
            : {}),
        }
      }
    } catch {
      // Ignore a corrupt or unavailable slot.
    }
    return null
  }
  function writeStoredAskModel(selection) {
    try {
      if (typeof localStorage === 'undefined') return
      if (selection && selection.provider && selection.model) localStorage.setItem(ASK_MODEL_KEY, JSON.stringify(selection))
      else localStorage.removeItem(ASK_MODEL_KEY)
    } catch {
      // Storage may be unavailable; the in-memory choice still applies.
    }
  }
  const storedAskModel = readStoredAskModel()
  if (storedAskModel) {
    store.set((state) => ({ ...state, ask: { ...state.ask, selection: storedAskModel } }))
  }

  const toast = (message, tone = 'info') => set((state) => ({ ...state, toast: { message, tone, at: Date.now() } }))
  const dismissToast = () => set((state) => (state.toast ? { ...state, toast: null } : state))
  const fail = (error) => {
    const message = error instanceof Error ? error.message : String(error)
    if (error && error.name === 'AbortError') return
    toast(message, 'error')
  }

  const saveProgressDebounced = debounce((snapshot) => {
    const current = get().current
    if (!current) return
    api.rpc('book/progress', { id: current.book.id, ...snapshot }).catch(() => undefined)
  }, 1200)

  function computePercent(chapterIndex, scrollRatio, chapterCount) {
    const count = Math.max(1, chapterCount || 1)
    const raw = (chapterIndex + clamp(scrollRatio, 0, 1)) / count
    return clamp(raw, 0, 1)
  }

  async function bootstrap() {
    if (bootstrapped) return
    bootstrapped = true
    set((state) => ({ ...state, status: 'loading', error: null }))
    try {
      const shelf = await api.rpc('shelf', {})
      set((state) => ({ ...state, status: 'ready', shelf, error: null }))
    } catch (error) {
      bootstrapped = false
      set((state) => ({
        ...state,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }

  async function refreshShelf() {
    try {
      const shelf = await api.rpc('shelf', {})
      set((state) => ({ ...state, shelf, status: 'ready' }))
      return shelf
    } catch (error) {
      fail(error)
      return null
    }
  }

  async function importFile(file) {
    if (!file) return null
    pendingImportAbort?.abort()
    const controller = new AbortController()
    pendingImportAbort = controller
    set((state) => ({ ...state, importing: true }))
    try {
      const result = await api.uploadEpub(file, controller.signal)
      set((state) => ({
        ...state,
        importing: false,
        shelf: {
          ...state.shelf,
          books: [result.book, ...state.shelf.books.filter((book) => book.id !== result.book.id)],
        },
      }))
      toast(tr(`已导入《${result.book.title}》，共 ${result.book.chapterCount} 章。`, `Imported "${result.book.title}" (${result.book.chapterCount} chapters).`))
      void refreshShelf()
      return result.book
    } catch (error) {
      if (!(error && error.name === 'AbortError')) set((state) => ({ ...state, importing: false }))
      fail(error)
      return null
    } finally {
      if (pendingImportAbort === controller) pendingImportAbort = null
    }
  }

  async function openBook(id) {
    if (!id) return
    set((state) => ({
      ...state,
      loadingBook: true,
      selection: null,
      view: 'reader',
      // A new book starts a fresh reader conversation; notes/bookmarks live in the library.
      ask: { ...state.ask, messages: [], draftQuote: null, streaming: false },
      reading: { ...state.reading, settingsOpen: false, notesOpen: false },
    }))
    try {
      const opened = await api.rpc('book/open', { id })
      set((state) => ({
        ...state,
        loadingBook: true,
        current: {
          book: opened.book,
          toc: opened.toc,
          chapterIndex: opened.chapterIndex,
          chapter: null,
          bookmarks: [],
        },
        notes: opened.notes || state.notes,
        loadingBook: true,
      }))
      const chapterIndex = opened.chapterIndex
      const [chapterData] = await Promise.all([
        api.rpc('book/chapter', { id, chapterIndex }),
        api.rpc('book/open-mark', { id, chapterIndex }).catch(() => undefined),
      ])
      const percent = computePercent(chapterIndex, opened.book.progress?.scrollRatio || 0, opened.toc.length)
      const scrollRatio = clamp(Number(opened.book.progress?.scrollRatio) || 0, 0, 1)
      set((state) => ({
        ...state,
        loadingBook: false,
        current: state.current
          ? { ...state.current, chapter: chapterData.chapter, chapterIndex, bookmarks: chapterData.bookmarks || [] }
          : state.current,
        progress: { chapterIndex, scrollRatio, percent },
      }))
      return chapterIndex
    } catch (error) {
      set((state) => ({ ...state, loadingBook: false, view: 'shelf' }))
      fail(error)
      return null
    }
  }

  async function loadChapter(chapterIndex, options = {}) {
    const current = get().current
    if (!current) return
    const index = clamp(Math.trunc(Number(chapterIndex) || 0), 0, Math.max(0, current.toc.length - 1))
    set((state) => ({ ...state, loadingBook: true, selection: null }))
    try {
      const data = await api.rpc('book/chapter', { id: current.book.id, chapterIndex: index })
      const scrollRatio = options.keepScroll ? 0 : 0
      const percent = computePercent(index, scrollRatio, current.toc.length)
      set((state) => ({
        ...state,
        loadingBook: false,
        current: state.current
          ? { ...state.current, chapterIndex: index, chapter: data.chapter, bookmarks: data.bookmarks || [] }
          : state.current,
        progress: { chapterIndex: index, scrollRatio, percent },
      }))
      saveProgressDebounced.flush({ chapterIndex: index, scrollRatio, percent })
    } catch (error) {
      set((state) => ({ ...state, loadingBook: false }))
      fail(error)
    }
  }

  function reportScroll(scrollRatio) {
    const state = get()
    const current = state.current
    if (!current) return
    const ratio = clamp(Number(scrollRatio) || 0, 0, 1)
    const percent = computePercent(current.chapterIndex, ratio, current.toc.length)
    const previous = state.progress
    if (Math.abs(previous.scrollRatio - ratio) < 0.0005 && Math.abs(previous.percent - percent) < 0.0005) return
    set({ ...state, progress: { chapterIndex: current.chapterIndex, scrollRatio: ratio, percent } })
    saveProgressDebounced({ chapterIndex: current.chapterIndex, scrollRatio: ratio, percent })
  }

  function flushProgress() {
    const state = get()
    if (!state.current) return
    saveProgressDebounced.flush({ ...state.progress })
  }

  function closeBook() {
    flushProgress()
    set((state) => ({ ...state, view: 'shelf', current: null, selection: null, search: { ...state.search, open: false } }))
    void refreshShelf()
  }

  function setView(view) {
    set((state) => ({ ...state, view }))
    if (view === 'notes') void loadNotes()
    if (view === 'shelf') void refreshShelf()
  }

  function setReadingPanel(patch) {
    set((state) => ({ ...state, reading: { ...state.reading, ...patch } }))
  }

  function setSelection(selection) {
    set((state) => ({ ...state, selection }))
  }

  function clearSelection() {
    set((state) => (state.selection ? { ...state, selection: null } : state))
  }

  async function setSettings(patch) {
    const previous = get().shelf.settings
    const next = { ...previous, ...patch }
    set((state) => ({ ...state, shelf: { ...state.shelf, settings: next } }))
    try {
      const result = await api.rpc('settings/save', { settings: patch })
      set((state) => ({ ...state, shelf: { ...state.shelf, settings: result.settings } }))
    } catch (error) {
      set((state) => ({ ...state, shelf: { ...state.shelf, settings: previous } }))
      fail(error)
    }
  }

  async function toggleBookmark() {
    const state = get()
    const current = state.current
    if (!current) return
    const existing = (current.bookmarks || []).find(
      (bookmark) => bookmark.chapterIndex === current.chapterIndex && Math.abs(bookmark.scrollRatio - state.progress.scrollRatio) < 0.02,
    )
    try {
      const result = existing
        ? await api.rpc('book/bookmark/remove', { id: current.book.id, bookmarkId: existing.id })
        : await api.rpc('book/bookmark/add', {
            id: current.book.id,
            chapterIndex: current.chapterIndex,
            scrollRatio: state.progress.scrollRatio,
            chapterTitle: current.chapter?.title || '',
            quote: state.selection?.text || '',
          })
      set((state) => ({
        ...state,
        current: state.current ? { ...state.current, bookmarks: result.bookmarks || [] } : state.current,
        reading: { ...state.reading, tocOpen: true },
      }))
      toast(existing ? tr('已移除书签', 'Bookmark removed') : tr('已添加书签', 'Bookmark added'))
    } catch (error) {
      fail(error)
    }
  }

  async function removeBookmark(bookmarkId) {
    const current = get().current
    if (!current) return
    try {
      const result = await api.rpc('book/bookmark/remove', { id: current.book.id, bookmarkId })
      set((state) => ({
        ...state,
        current: state.current ? { ...state.current, bookmarks: result.bookmarks || [] } : state.current,
      }))
    } catch (error) {
      fail(error)
    }
  }

  /** Stable id for one chat message. */
  function makeAskMessageId() {
    return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  }

  /** Collect complete question/answer pairs for the model's short-term history. */
  function askHistory(messages) {
    const pairs = []
    let pending = null
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue
      if (message.role === 'user') {
        pending = message
        continue
      }
      if (message.role === 'assistant' && pending && message.text) {
        pairs.push({ question: pending.text, answer: message.text })
        pending = null
      }
    }
    return pairs.slice(-4)
  }

  /**
   * Append one assistant message and stream the model answer into it.
   * The caller appends the user message first (see `askWithQuote`).
   */
  async function streamAnswer(question, quote, chapterIndex) {
    const current = get().current
    if (!current) return
    askAbort?.abort()
    const controller = new AbortController()
    askAbort = controller
    const assistantId = makeAskMessageId()
    const assistantMessage = {
      id: assistantId,
      role: 'assistant',
      text: '',
      reasoning: '',
      model: null,
      streaming: true,
      error: null,
      quote: '',
      question,
      chapterIndex,
      createdAt: Date.now(),
    }
    set((state) => ({
      ...state,
      ask: { ...state.ask, streaming: true, messages: [...state.ask.messages, assistantMessage] },
    }))
    const history = askHistory(get().ask.messages.slice(0, -1))
    const selection = get().ask.selection
    const patchAssistant = (patch) =>
      set((state) => ({
        ...state,
        ask: {
          ...state.ask,
          messages: state.ask.messages.map((message) =>
            message.id === assistantId ? { ...message, ...patch } : message,
          ),
        },
      }))
    try {
      await api.streamAsk(
        {
          id: current.book.id,
          chapterIndex,
          quote,
          question,
          history,
          ...(selection && selection.provider ? { provider: selection.provider } : {}),
          ...(selection && selection.model ? { model: selection.model } : {}),
          ...(selection && selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        },
        {
          signal: controller.signal,
          onDelta: (delta) => patchAssistant({ text: (get().ask.messages.find((m) => m.id === assistantId)?.text || '') + delta }),
          onReasoning: (delta) =>
            patchAssistant({ reasoning: (get().ask.messages.find((m) => m.id === assistantId)?.reasoning || '') + delta }),
          onModel: (model) =>
            set((state) => ({
              ...state,
              ask: {
                ...state.ask,
                activeModel: model && model.model ? { provider: model.provider, model: model.model } : state.ask.activeModel,
                messages: state.ask.messages.map((message) =>
                  message.id === assistantId
                    ? { ...message, model: model && model.model ? { provider: model.provider, model: model.model } : message.model }
                    : message,
                ),
              },
            })),
          onError: (error) => patchAssistant({ streaming: false, error: error.message }),
          onDone: () =>
            set((state) => ({
              ...state,
              ask: {
                ...state.ask,
                streaming: false,
                messages: state.ask.messages.map((message) =>
                  message.id === assistantId ? { ...message, streaming: false } : message,
                ),
              },
            })),
        },
      )
    } catch (error) {
      if (error && error.name === 'AbortError') return
      patchAssistant({ streaming: false, error: error.message })
    } finally {
      if (askAbort === controller) askAbort = null
    }
  }

  /** Ask about a passage: append the user turn, then stream the answer. */
  async function askWithQuote(question, options = {}) {
    const state = get()
    const current = state.current
    if (!current) return null
    const trimmed = String(question || '').trim()
    if (!trimmed) return null
    const draft = state.ask.draftQuote || null
    const quote = typeof options.quote === 'string' ? options.quote : draft ? draft.text : ''
    const chapterIndex = Number.isInteger(options.chapterIndex)
      ? options.chapterIndex
      : draft && Number.isInteger(draft.chapterIndex)
        ? draft.chapterIndex
        : current.chapterIndex
    const userMessage = {
      id: makeAskMessageId(),
      role: 'user',
      text: trimmed,
      quote,
      chapterIndex,
      createdAt: Date.now(),
    }
    set((state) => ({
      ...state,
      selection: null,
      ask: { ...state.ask, draftQuote: null, messages: [...state.ask.messages, userMessage] },
    }))
    await streamAnswer(trimmed, quote, chapterIndex)
    return userMessage
  }

  /** Park a selection for the composer's next question ("自己提问"). */
  function beginQuestion(quote, chapterIndex) {
    const state = get()
    if (!state.current) return
    const text = String(quote || '').trim()
    set((state) => ({
      ...state,
      selection: null,
      ask: {
        ...state.ask,
        draftQuote: text
          ? {
              text,
              chapterIndex: Number.isInteger(chapterIndex) ? chapterIndex : state.current ? state.current.chapterIndex : 0,
            }
          : null,
      },
    }))
  }

  /** Drop the parked quote without asking. */
  function clearDraftQuote() {
    set((state) => (state.ask.draftQuote ? { ...state, ask: { ...state.ask, draftQuote: null } } : state))
  }

  function cancelAsk() {
    askAbort?.abort()
    askAbort = null
    set((state) => ({
      ...state,
      ask: {
        ...state.ask,
        streaming: false,
        messages: state.ask.messages.map((message) => (message.streaming ? { ...message, streaming: false } : message)),
      },
    }))
  }

  function clearChat() {
    askAbort?.abort()
    askAbort = null
    set((state) => ({ ...state, ask: { ...state.ask, messages: [], draftQuote: null, streaming: false } }))
  }

  /** Load the routable chat models for the composer's model picker. */
  async function loadAskModels() {
    const state = get()
    if (state.ask.models || state.ask.modelsLoading) return state.ask.models
    set((state) => ({ ...state, ask: { ...state.ask, modelsLoading: true, modelsError: null } }))
    try {
      const result = await api.rpc('ask/models', {})
      const models = result && result.models ? result.models : null
      // Never drop the user's chosen model just because a provider's model list was
      // slow, partial, or failed: the choice is what the next request sends.
      set((state) => ({
        ...state,
        ask: {
          ...state.ask,
          models,
          modelsLoading: false,
          modelsError: null,
        },
      }))
      return models
    } catch (error) {
      set((state) => ({ ...state, ask: { ...state.ask, modelsLoading: false, modelsError: error.message } }))
      return null
    }
  }

  /** Choose the route for future answers; `null` follows the default model. */
  function setAskModel(selection) {
    const value =
      selection && typeof selection.provider === 'string' && typeof selection.model === 'string'
        ? {
            provider: selection.provider,
            model: selection.model,
            ...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort
              ? { reasoningEffort: selection.reasoningEffort }
              : {}),
          }
        : null
    writeStoredAskModel(value)
    set((state) => ({ ...state, ask: { ...state.ask, selection: value } }))
  }

  /** Re-run the answer for one failed or cancelled assistant message. */
  async function retryAsk(messageId) {
    const state = get()
    const index = state.ask.messages.findIndex((message) => message.id === messageId)
    if (index < 0) return
    const assistant = state.ask.messages[index]
    if (!assistant || assistant.role !== 'assistant') return
    const user = [...state.ask.messages.slice(0, index)].reverse().find((message) => message.role === 'user')
    if (!user) return
    set((state) => ({
      ...state,
      ask: { ...state.ask, messages: state.ask.messages.filter((message) => message.id !== messageId) },
    }))
    await streamAnswer(user.text, user.quote, user.chapterIndex)
  }

  /** The user/assistant pair that one assistant message belongs to. */
  function findAskPair(messageId) {
    const messages = get().ask.messages
    const index = messages.findIndex((message) => message.id === messageId)
    if (index < 0) return null
    const assistant = messages[index]
    if (!assistant || assistant.role !== 'assistant') return null
    const user = [...messages.slice(0, index)].reverse().find((message) => message.role === 'user') || null
    return { user, assistant }
  }

  /** Persist one chat answer as a reading note. */
  async function saveMessageNote(messageId) {
    const state = get()
    const current = state.current
    const pair = findAskPair(messageId)
    if (!current || !pair || !pair.assistant.text) return null
    const chapterIndex = Number.isInteger(pair.assistant.chapterIndex)
      ? pair.assistant.chapterIndex
      : current.chapterIndex
    try {
      const result = await api.rpc('note/save', {
        note: {
          bookId: current.book.id,
          bookTitle: current.book.title,
          chapterIndex,
          chapterTitle: current.toc[chapterIndex]?.title || current.chapter?.title || '',
          quote: pair.user ? pair.user.quote : '',
          question: pair.user ? pair.user.text : '',
          answer: pair.assistant.text,
          note: '',
          tags: [],
        },
      })
      set((state) => ({
        ...state,
        notes: result.notes || state.notes,
        shelf: { ...state.shelf, notesCount: (result.notes || []).length },
      }))
      toast(tr('已存为笔记', 'Saved to notes'))
      return result.note
    } catch (error) {
      fail(error)
      return null
    }
  }

  /** Continue one chat answer in a normal conversation via the native composer. */
  async function bringMessageToConversation(messageId) {
    const state = get()
    const current = state.current
    const pair = findAskPair(messageId)
    if (!current || !pair) return
    const chapterIndex = Number.isInteger(pair.assistant.chapterIndex)
      ? pair.assistant.chapterIndex
      : current.chapterIndex
    try {
      const { prompt } = await api.rpc('conversation/prompt', {
        id: current.book.id,
        chapterIndex,
        quote: pair.user ? pair.user.quote : '',
        question: pair.user ? pair.user.text : '',
      })
      const uiWorkspace = ctx.get('uiWorkspace')
      if (!uiWorkspace || typeof uiWorkspace.startSession !== 'function') {
        throw readingError('reading/no-workspace', tr('当前页面无法创建对话。', 'This page cannot create a conversation.'))
      }
      uiWorkspace.startSession(undefined, { prompt, whenDraftExists: 'append' })
      toast(tr('已带入新对话，确认后发送即可。', 'Moved to a new conversation draft.'))
    } catch (error) {
      fail(error)
    }
  }

  async function loadNotes(query) {
    set((state) => ({ ...state, notesLoading: true, notesQuery: typeof query === 'string' ? query : state.notesQuery }))
    try {
      // Load the whole notebook: the notes page filters by book locally and the
      // reader-side drawer narrows to the open book, so scoping the read to the
      // current book would make "全部笔记" wrong.
      const notes = await api.rpc('note/list', {
        q: typeof query === 'string' ? query : get().notesQuery,
      })
      set((state) => ({ ...state, notes: notes.notes || [], notesLoading: false, shelf: { ...state.shelf, notesCount: (notes.notes || []).length } }))
    } catch (error) {
      set((state) => ({ ...state, notesLoading: false }))
      fail(error)
    }
  }

  async function saveNote(note) {
    try {
      const result = await api.rpc('note/save', { note })
      set((state) => ({ ...state, notes: result.notes || state.notes }))
      toast(tr('笔记已保存', 'Note saved'))
      return result.note
    } catch (error) {
      fail(error)
      return null
    }
  }

  async function deleteNote(id) {
    try {
      const result = await api.rpc('note/delete', { id })
      set((state) => ({ ...state, notes: result.notes || [] }))
      toast(tr('笔记已删除', 'Note deleted'))
    } catch (error) {
      fail(error)
    }
  }

  async function exportNotes(bookId) {
    try {
      const result = await api.rpc('note/export', { bookId })
      if (!result.count) {
        toast(tr('还没有笔记可以导出', 'No notes to export'))
        return
      }
      const stamp = new Date().toISOString().slice(0, 10)
      downloadText(`reading-notes-${stamp}.md`, result.markdown)
      toast(tr(`已导出 ${result.count} 条笔记`, `Exported ${result.count} notes`))
    } catch (error) {
      fail(error)
    }
  }

  async function search(query) {
    const q = String(query || '').trim()
    if (!q) {
      set((state) => ({ ...state, search: { ...state.search, results: [], q: '' } }))
      return
    }
    set((state) => ({ ...state, search: { ...state.search, q, loading: true } }))
    try {
      const { results } = await api.rpc('search', {
        q,
        bookId: get().current?.book.id,
        limit: 30,
      })
      set((state) => ({ ...state, search: { ...state.search, loading: false, results } }))
    } catch (error) {
      set((state) => ({ ...state, search: { ...state.search, loading: false } }))
      fail(error)
    }
  }

  function openSearch() {
    set((state) => ({ ...state, search: { ...state.search, open: true } }))
  }

  function closeSearch() {
    set((state) => ({ ...state, search: { ...state.search, open: false, results: [], q: '' } }))
  }

  const actions = {
    bootstrap,
    refreshShelf,
    importFile,
    openBook,
    loadChapter,
    reportScroll,
    flushProgress,
    closeBook,
    setView,
    setReadingPanel,
    setSelection,
    clearSelection,
    setSettings,
    toggleBookmark,
    removeBookmark,
    askWithQuote,
    beginQuestion,
    clearDraftQuote,
    cancelAsk,
    clearChat,
    loadAskModels,
    setAskModel,
    retryAsk,
    saveMessageNote,
    bringMessageToConversation,
    loadNotes,
    saveNote,
    deleteNote,
    exportNotes,
    search,
    openSearch,
    closeSearch,
    toast,
    dismissToast,
    fail,
  }

  READING_STORE = store
  READING_ACTIONS = actions
  READING_API = api
  return { store, actions, api }
}
