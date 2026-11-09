/**
 * Notes and search surfaces for the reading page.
 *
 * `NotesView` is the full-page 笔记 tab (filter rail + note list), `NotesDrawer`
 * is the reader-side drawer for the open book, and `SearchOverlay` is the
 * full-text search overlay over books. `NoteEditorDialog` is shared by the notes
 * surfaces and by 60-ask's selection toolbar, so a passage and a stored note are
 * edited with exactly the same form.
 */

/** Trim one-line preview text, adding an ellipsis when it was cut. */
function notesTruncate(text, max) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  if (!value) return ''
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}

/** Resolve the 1-based chapter label of a note. */
function noteChapterLabel(note) {
  const index = note && Number.isInteger(note.chapterIndex) ? note.chapterIndex : 0
  const title = String((note && note.chapterTitle) || '').trim()
  return title ? tr(`第 ${index + 1} 章 · ${title}`, `Chapter ${index + 1} · ${title}`) : tr(`第 ${index + 1} 章`, `Chapter ${index + 1}`)
}

/** Serialise one note as the Markdown blob the 复制 action puts on the clipboard. */
function noteToMarkdown(note) {
  if (!note) return ''
  const lines = []
  const book = String(note.bookTitle || '').trim()
  lines.push(`### ${book ? `《${book}》` : ''}${noteChapterLabel(note)}`)
  const quote = String(note.quote || '').trim()
  if (quote) {
    lines.push('')
    lines.push(
      quote
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n'),
    )
  }
  const question = String(note.question || '').trim()
  if (question) {
    lines.push('')
    lines.push(`**${tr('问', 'Q')}**：${question}`)
  }
  const answer = String(note.answer || '').trim()
  if (answer) {
    lines.push('')
    lines.push(answer)
  }
  const extra = String(note.note || '').trim()
  if (extra) {
    lines.push('')
    lines.push(`**${tr('补记', 'Note')}**：${extra}`)
  }
  const tags = Array.isArray(note.tags) ? note.tags.filter(Boolean) : []
  if (tags.length > 0) {
    lines.push('')
    lines.push(tags.map((tag) => `#${tag}`).join(' '))
  }
  lines.push('')
  return lines.join('\n')
}

/** Split a snippet into plain text and highlighted query matches. */
function searchHighlight(text, query) {
  const value = String(text == null ? '' : text)
  const needle = String(query == null ? '' : query).trim()
  if (!needle) return [value]
  const pattern = new RegExp(`(${escapeRegExp(needle)})`, 'ig')
  return value.split(pattern).map((part, index) => (index % 2 === 1 ? h('mark', { key: `mark-${index}`, className: 'rd-search-mark' }, part) : part))
}

/**
 * Shared note editor dialog. Mount it only while it should be open — the form
 * state is seeded from `initial` on mount.
 *
 * @param {object} props
 * @param {string} props.title
 * @param {string} [props.description]
 * @param {{quote?:string, note?:string, answer?:string, tags?:string[]}} [props.initial]
 * @param {boolean} [props.allowQuote]  edit the passage; otherwise it is shown read-only
 * @param {boolean} [props.allowAnswer] edit the stored answer
 * @param {Function} props.onClose
 * @param {(patch:{quote:string,note:string,answer:string,tags:string[]}) => Promise<boolean>|boolean} props.onSubmit
 */
function NoteEditorDialog({ title, description, initial, allowQuote = true, allowAnswer = true, onClose, onSubmit }) {
  const source = initial && typeof initial === 'object' ? initial : {}
  const [quote, setQuote] = useState(String(source.quote || ''))
  const [noteText, setNoteText] = useState(String(source.note || ''))
  const [answer, setAnswer] = useState(String(source.answer || ''))
  const [tagsText, setTagsText] = useState(Array.isArray(source.tags) ? source.tags.join('，') : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const patch = {
        quote: allowQuote ? quote.trim() : String(source.quote || ''),
        note: noteText.trim(),
        answer: allowAnswer ? answer.trim() : String(source.answer || ''),
        tags: parseTagInput(tagsText),
      }
      const result = await onSubmit(patch)
      if (result === false) setError(tr('保存失败，请重试。', 'Could not save. Please try again.'))
      else if (typeof onClose === 'function') onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const readOnlyQuote = !allowQuote && String(source.quote || '').trim().length > 0
  return h(
    Dialog,
    {
      open: true,
      onClose,
      title,
      description,
      footer: [
        h(Button, { key: 'cancel', variant: 'ghost', onClick: onClose }, tr('取消', 'Cancel')),
        h(
          Button,
          { key: 'save', variant: 'primary', icon: 'check', disabled: busy, onClick: () => void submit() },
          busy ? tr('保存中…', 'Saving…') : tr('保存', 'Save'),
        ),
      ],
    },
    error ? h(Notice, { key: 'error', tone: 'error' }, error) : null,
    readOnlyQuote ? h('blockquote', { key: 'quote', className: 'rd-notes-quote-block' }, String(source.quote || '')) : null,
    allowQuote
      ? h(TextField, {
          key: 'quote-field',
          label: tr('原文', 'Passage'),
          value: quote,
          onChange: setQuote,
          multiline: true,
          rows: 3,
          placeholder: tr('可留空，也可粘贴想批注的原文', 'Optional: paste the passage you want to annotate'),
        })
      : null,
    allowAnswer
      ? h(TextField, {
          key: 'answer-field',
          label: tr('回答', 'Answer'),
          value: answer,
          onChange: setAnswer,
          multiline: true,
          rows: 4,
          placeholder: tr('支持 Markdown', 'Markdown is supported'),
        })
      : null,
    h(TextField, {
      key: 'note-field',
      label: tr('补记', 'Your note'),
      value: noteText,
      onChange: setNoteText,
      multiline: true,
      rows: 3,
      placeholder: tr('写下你的想法…', 'Write down your thoughts…'),
    }),
    h(TextField, {
      key: 'tags-field',
      label: tr('标签', 'Tags'),
      value: tagsText,
      onChange: setTagsText,
      placeholder: tr('用逗号或空格分隔', 'Separate with commas or spaces'),
    }),
  )
}

/** One note card, shared by the notes page (full) and the reader drawer (compact). */
function NoteCard({ note, actions, onEdit, onDelete, onJump, compact }) {
  if (!note) return null
  const created = formatDate(note.createdAt)
  const tags = Array.isArray(note.tags) ? note.tags.filter(Boolean) : []
  const quote = String(note.quote || '').trim()
  const question = String(note.question || '').trim()
  const answer = String(note.answer || '').trim()
  const extra = String(note.note || '').trim()

  const copyNote = async () => {
    const copied = await copyTextSafe(noteToMarkdown(note))
    if (actions && typeof actions.toast === 'function') {
      actions.toast(copied ? tr('已复制笔记 Markdown', 'Note copied as Markdown') : tr('复制失败', 'Copy failed'), copied ? 'info' : 'error')
    }
  }

  const head = compact
    ? h('div', { className: 'rd-notes-card-head' }, h('div', { className: 'rd-notes-card-chapter' }, noteChapterLabel(note)))
    : h(
        'div',
        { className: 'rd-notes-card-head' },
        h(
          'div',
          { className: 'rd-notes-card-titles' },
          h('div', { className: 'rd-notes-card-book' }, String(note.bookTitle || tr('未命名书籍', 'Untitled book'))),
          h('div', { className: 'rd-notes-card-chapter' }, noteChapterLabel(note)),
        ),
        created ? h('span', { className: 'rd-notes-card-date' }, created) : null,
      )

  return h(
    'article',
    { className: cx('rd-notes-card', compact && 'is-compact') },
    head,
    quote ? h('blockquote', { className: 'rd-notes-card-quote' }, quote) : null,
    question
      ? h(
          'div',
          { className: 'rd-notes-card-qa' },
          h('span', { className: 'rd-notes-card-qa-label' }, tr('问', 'Q')),
          h('span', { className: 'rd-notes-card-q' }, question),
        )
      : null,
    answer
      ? h(
          'div',
          { className: 'rd-notes-card-qa' },
          h('span', { className: 'rd-notes-card-qa-label' }, tr('答', 'A')),
          compact
            ? h('span', { className: 'rd-notes-card-answer-excerpt' }, notesTruncate(answer, 180))
            : h(MarkdownText, { text: answer }),
        )
      : null,
    extra
      ? h(
          'div',
          { className: 'rd-notes-card-note' },
          h('span', { className: 'rd-notes-card-note-label' }, tr('补记', 'Note')),
          h('span', { className: 'rd-notes-card-note-text' }, extra),
        )
      : null,
    tags.length > 0 ? h('div', { className: 'rd-notes-card-tags' }, tags.map((tag) => h('span', { key: tag, className: 'rd-notes-tag' }, `#${tag}`))) : null,
    h(
      'div',
      { className: 'rd-notes-card-actions' },
      !compact ? h(Button, { size: 'sm', variant: 'ghost', icon: 'edit', onClick: () => onEdit && onEdit(note) }, tr('编辑', 'Edit')) : null,
      h(Button, { size: 'sm', variant: 'ghost', icon: 'bookOpen', onClick: () => onJump && onJump(note) }, tr('跳转原文', 'Go to passage')),
      !compact
        ? h(
            Button,
            { size: 'sm', variant: 'ghost', icon: 'copy', onClick: () => void copyNote() },
            tr('复制 Markdown', 'Copy Markdown'),
          )
        : null,
      h(Button, { size: 'sm', variant: 'ghost', icon: 'trash', onClick: () => onDelete && onDelete(note), className: 'rd-notes-danger' }, tr('删除', 'Delete')),
    ),
  )
}

/** The 笔记 tab: filter rail on the left, note list on the right. */
function NotesView({ state, actions }) {
  const notes = Array.isArray(state.notes) ? state.notes : []
  const current = state.current || null
  const currentBook = current && current.book ? current.book : null
  const [scope, setScope] = useState('all')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(null)
  const [confirming, setConfirming] = useState(null)

  const loadNotes = useMemo(() => debounce((value) => void actions.loadNotes(value), 300), [actions])
  useEffect(() => () => loadNotes.cancel(), [loadNotes])

  const closeEditor = useCallback(() => setEditing(null), [])
  const closeConfirm = useCallback(() => setConfirming(null), [])

  const onQueryChange = useCallback(
    (value) => {
      setQuery(value)
      loadNotes(value)
    },
    [loadNotes],
  )

  useEffect(() => {
    if (!currentBook && scope === 'book') setScope('all')
  }, [currentBook, scope])

  const trimmedQuery = query.trim()
  const bookNotes = currentBook ? notes.filter((note) => note && note.bookId === currentBook.id) : []
  const visible = scope === 'book' ? bookNotes : notes
  const nothingAtAll = notes.length === 0 && !trimmedQuery

  const jumpToNote = async (note) => {
    if (!note || !note.bookId) {
      actions.toast(tr('找不到这本书', 'The book is missing'), 'error')
      return
    }
    const opened = await actions.openBook(note.bookId)
    if (opened === null || opened === undefined) return
    await actions.loadChapter(Number.isInteger(note.chapterIndex) ? note.chapterIndex : 0)
  }

  const confirmDelete = async () => {
    const note = confirming
    if (!note) return
    await actions.deleteNote(note.id)
    setConfirming(null)
  }

  let listContent
  if (visible.length > 0) {
    listContent = h(
      'div',
      { className: 'rd-notes-list' },
      visible.map((note) =>
        h(NoteCard, {
          key: note.id,
          note,
          actions,
          onEdit: setEditing,
          onDelete: setConfirming,
          onJump: (value) => void jumpToNote(value),
        }),
      ),
    )
  } else if (state.notesLoading) {
    listContent = h('div', { className: 'rd-notes-loading' }, h(Spinner, { size: 18 }), h('span', null, tr('正在读取笔记…', 'Loading notes…')))
  } else if (nothingAtAll && scope === 'all') {
    listContent = h(Empty, {
      icon: 'note',
      title: tr('还没有笔记', 'No notes yet'),
      description: tr(
        '在正文里选中一段文字，点「问 AI」，回答出来后点「存为笔记」，笔记就会收集到这里。',
        'Select a passage, ask AI, then choose "Save as note" — your notes collect here.',
      ),
      action: h(Button, { variant: 'primary', icon: 'book', onClick: () => actions.setView('shelf') }, tr('去书架', 'Go to the shelf')),
    })
  } else {
    const isFiltered = Boolean(trimmedQuery) || scope === 'book'
    listContent = h(Empty, {
      icon: isFiltered ? 'search' : 'note',
      title: trimmedQuery
        ? tr(`没有匹配「${trimmedQuery}」的笔记`, `No notes matching "${trimmedQuery}"`)
        : scope === 'book'
          ? tr('这本书还没有笔记', 'No notes for this book yet')
          : tr('这里还没有笔记', 'Nothing here yet'),
      description: trimmedQuery
        ? tr('换个关键词，或清除搜索查看全部笔记。', 'Try another keyword, or clear the search to see every note.')
        : tr('在正文里选中文字问 AI，再把回答存为笔记。', 'Ask AI about a passage, then save the answer as a note.'),
      action: trimmedQuery
        ? h(
            Button,
            {
              size: 'sm',
              variant: 'ghost',
              icon: 'close',
              onClick: () => {
                setQuery('')
                void actions.loadNotes('')
              },
            },
            tr('清除搜索', 'Clear search'),
          )
        : null,
    })
  }

  const rail = h(
    'aside',
    { className: 'rd-notes-rail' },
    h(
      'button',
      { type: 'button', className: cx('rd-notes-pill', scope === 'all' && 'is-active'), onClick: () => setScope('all') },
      h(Icon, { name: 'note', size: 14 }),
      h('span', { className: 'rd-notes-pill-label' }, tr('全部笔记', 'All notes')),
      h('span', { className: 'rd-notes-pill-count' }, String(notes.length)),
    ),
    h(
      'button',
      {
        type: 'button',
        className: cx('rd-notes-pill', scope === 'book' && 'is-active'),
        disabled: !currentBook,
        title: currentBook ? tr(`仅看《${currentBook.title}》`, `Only "${currentBook.title}"`) : tr('打开一本书后才能按书筛选', 'Open a book to filter by book'),
        onClick: () => setScope('book'),
      },
      h(Icon, { name: 'book', size: 14 }),
      h('span', { className: 'rd-notes-pill-label' }, tr('当前书', 'This book')),
      h('span', { className: 'rd-notes-pill-count' }, currentBook ? String(bookNotes.length) : '—'),
    ),
    h('div', { className: 'rd-notes-rail-sep' }),
    h(TextField, { value: query, onChange: onQueryChange, placeholder: tr('搜索笔记…', 'Search notes…') }),
    state.notesLoading ? h('div', { className: 'rd-notes-rail-loading' }, h(Spinner, { size: 12 }), h('span', null, tr('搜索中…', 'Searching…'))) : null,
  )

  return h(
    'div',
    { className: 'rd-notes-view' },
    h(
      'div',
      { className: 'rd-notes-layout' },
      rail,
      h(
        'section',
        { className: 'rd-notes-main' },
        h(
          'div',
          { className: 'rd-notes-list-head' },
          h('div', { className: 'rd-notes-list-count' }, state.notesLoading ? tr('正在加载…', 'Loading…') : tr(`共 ${visible.length} 条笔记`, `${visible.length} notes`)),
          trimmedQuery
            ? h(
                Button,
                {
                  size: 'sm',
                  variant: 'ghost',
                  icon: 'close',
                  onClick: () => {
                    setQuery('')
                    void actions.loadNotes('')
                  },
                },
                tr('清除搜索', 'Clear search'),
              )
            : null,
        ),
        listContent,
      ),
    ),
    editing
      ? h(NoteEditorDialog, {
          key: `edit-${editing.id}`,
          title: tr('编辑笔记', 'Edit note'),
          description: tr('补记、回答与标签都可以随时修改。', 'Notes, answers and tags can be updated anytime.'),
          initial: {
            quote: editing.quote || '',
            note: editing.note || '',
            answer: editing.answer || '',
            tags: Array.isArray(editing.tags) ? editing.tags : [],
          },
          allowQuote: false,
          onClose: closeEditor,
          onSubmit: async (patch) => {
            const saved = await actions.saveNote({
              ...editing,
              quote: patch.quote,
              note: patch.note,
              answer: patch.answer,
              tags: patch.tags,
            })
            return Boolean(saved)
          },
        })
      : null,
    confirming
      ? h(
          Dialog,
          {
            key: `delete-${confirming.id}`,
            open: true,
            onClose: closeConfirm,
            title: tr('删除这条笔记？', 'Delete this note?'),
            description: tr('删除后无法恢复。', 'This cannot be undone.'),
            footer: [
              h(Button, { key: 'cancel', variant: 'ghost', onClick: closeConfirm }, tr('取消', 'Cancel')),
              h(Button, { key: 'delete', variant: 'danger', icon: 'trash', onClick: () => void confirmDelete() }, tr('删除', 'Delete')),
            ],
          },
          h('blockquote', { className: 'rd-notes-quote-block' }, notesTruncate(confirming.quote || confirming.question || confirming.answer || confirming.note || '', 160)),
        )
      : null,
  )
}

/** Reader-side notes drawer for the currently open book. */
function NotesDrawer({ state, actions }) {
  const current = state.current
  const reading = state.reading || {}
  const notesOpen = Boolean(reading.notesOpen)
  const book = current && current.book ? current.book : null
  const chapterIndex = current && Number.isInteger(current.chapterIndex) ? current.chapterIndex : 0
  const tocEntry = current && current.toc && current.toc[chapterIndex] ? current.toc[chapterIndex] : null
  const chapterTitle = (tocEntry && tocEntry.title) || (current && current.chapter && current.chapter.title) || ''
  const allNotes = Array.isArray(state.notes) ? state.notes : []

  const [editor, setEditor] = useState(null)
  const [confirming, setConfirming] = useState(null)
  const closeEditor = useCallback(() => setEditor(null), [])
  const closeConfirm = useCallback(() => setConfirming(null), [])

  useEffect(() => {
    if (!notesOpen || editor || confirming) return undefined
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      const busyElsewhere = Boolean((state.search && state.search.open) || (state.reading && state.reading.settingsOpen))
      if (busyElsewhere) return
      actions.setReadingPanel({ notesOpen: false })
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [notesOpen, editor, confirming, actions, state.search, state.reading])

  if (!current || !book || !notesOpen) return null

  const bookNotes = allNotes.filter((note) => note && note.bookId === book.id)

  const openNewNote = () => {
    const selection = state.selection
    setEditor({
      initial: {
        quote: selection && selection.text ? selection.text : '',
        note: '',
        answer: '',
        tags: [],
      },
    })
    actions.clearSelection()
  }

  const jumpToNote = async (note) => {
    if (!note) return
    const index = Number.isInteger(note.chapterIndex) ? note.chapterIndex : 0
    actions.setReadingPanel({ notesOpen: false })
    await actions.loadChapter(index)
  }

  const confirmDelete = async () => {
    if (!confirming) return
    await actions.deleteNote(confirming.id)
    setConfirming(null)
  }

  let body
  if (bookNotes.length === 0) {
    body = h(Empty, {
      icon: 'note',
      title: tr('这本书还没有笔记', 'No notes for this book yet'),
      description: tr('选中一段正文问 AI，回答出现后点「存为笔记」；也可以直接新建一条。', 'Ask AI about a passage and save the answer, or create a note directly.'),
      action: h(Button, { variant: 'secondary', size: 'sm', icon: 'plus', onClick: openNewNote }, tr('新建笔记', 'New note')),
    })
  } else {
    body = h(
      'div',
      { className: 'rd-notes-drawer-list' },
      bookNotes.map((note) =>
        h(NoteCard, {
          key: note.id,
          note,
          actions,
          compact: true,
          onDelete: setConfirming,
          onJump: (value) => void jumpToNote(value),
        }),
      ),
    )
  }

  return h(
    'aside',
    { className: 'rd-notes-drawer', role: 'dialog', 'aria-modal': 'false', 'aria-label': tr('笔记', 'Notes') },
    h(
      'header',
      { className: 'rd-notes-drawer-head' },
      h(
        'div',
        { className: 'rd-notes-drawer-title' },
        h(Icon, { name: 'note', size: 15 }),
        h('span', null, tr('笔记', 'Notes')),
        h('span', { className: 'rd-notes-drawer-count' }, String(bookNotes.length)),
      ),
      h(Button, { size: 'sm', variant: 'secondary', icon: 'plus', onClick: openNewNote }, tr('新建笔记', 'New note')),
      h(IconButton, { icon: 'close', label: tr('关闭笔记', 'Close notes'), onClick: () => actions.setReadingPanel({ notesOpen: false }) }),
    ),
    h('div', { className: 'rd-notes-drawer-body' }, body),
    editor
      ? h(NoteEditorDialog, {
          key: 'new-note',
          title: tr('新建笔记', 'New note'),
          description: tr('笔记会归到当前这本书的当前章节。', 'The note is filed under this book and chapter.'),
          initial: editor.initial,
          allowQuote: true,
          allowAnswer: false,
          onClose: closeEditor,
          onSubmit: async (patch) => {
            const saved = await actions.saveNote({
              bookId: book.id,
              bookTitle: book.title || '',
              chapterIndex,
              chapterTitle,
              quote: patch.quote,
              question: '',
              answer: '',
              note: patch.note,
              tags: patch.tags,
            })
            return Boolean(saved)
          },
        })
      : null,
    confirming
      ? h(
          Dialog,
          {
            key: `drawer-delete-${confirming.id}`,
            open: true,
            onClose: closeConfirm,
            title: tr('删除这条笔记？', 'Delete this note?'),
            description: tr('删除后无法恢复。', 'This cannot be undone.'),
            footer: [
              h(Button, { key: 'cancel', variant: 'ghost', onClick: closeConfirm }, tr('取消', 'Cancel')),
              h(Button, { key: 'delete', variant: 'danger', icon: 'trash', onClick: () => void confirmDelete() }, tr('删除', 'Delete')),
            ],
          },
          h('blockquote', { className: 'rd-notes-quote-block' }, notesTruncate(confirming.quote || confirming.question || confirming.answer || confirming.note || '', 160)),
        )
      : null,
  )
}

/** Full-text search overlay rendered by 80-panel while `state.search.open`. */
function SearchOverlay({ state, actions }) {
  const search = state.search && typeof state.search === 'object' ? state.search : {}
  const searchOpen = Boolean(search.open)
  const [query, setQuery] = useState(typeof search.q === 'string' ? search.q : '')
  const inputRef = useRef(null)

  const runSearch = useMemo(() => debounce((value) => void actions.search(value), 300), [actions])
  useEffect(() => () => runSearch.cancel(), [runSearch])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const node = inputRef.current
      if (node && typeof node.focus === 'function') node.focus()
    }, 0)
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      actions.closeSearch()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('keydown', onKeyDown, true)
      runSearch.cancel()
    }
  }, [actions, runSearch])

  if (!searchOpen) return null

  const q = query.trim()
  const results = Array.isArray(search.results) ? search.results : []
  const loading = Boolean(search.loading)

  const choose = async (result) => {
    if (!result || !result.bookId) return
    actions.closeSearch()
    const opened = await actions.openBook(result.bookId)
    if (opened === null || opened === undefined) return
    await actions.loadChapter(Number.isInteger(result.chapterIndex) ? result.chapterIndex : 0)
  }

  let body
  if (loading) {
    body = h('div', { className: 'rd-search-empty' }, h(Spinner, { size: 18 }), h('div', null, tr('搜索中…', 'Searching…')))
  } else if (!q) {
    body = h(
      'div',
      { className: 'rd-search-empty' },
      h(Icon, { name: 'search', size: 24 }),
      h('div', { className: 'rd-search-empty-title' }, tr('搜索书名与正文', 'Search titles and text')),
      h('div', { className: 'rd-search-empty-hint' }, tr('输入人名、地名或一句原文试试。', 'Try a name, a place, or a phrase from the text.')),
    )
  } else if (results.length === 0) {
    body = h(
      'div',
      { className: 'rd-search-empty' },
      h(Icon, { name: 'search', size: 24 }),
      h('div', { className: 'rd-search-empty-title' }, tr(`无匹配：没有找到「${q}」`, `No matches for "${q}"`)),
      h('div', { className: 'rd-search-empty-hint' }, tr('换个关键词，或检查是否选错了书。', 'Try another keyword, or check whether you are searching the right book.')),
    )
  } else {
    body = h(
      'div',
      { className: 'rd-search-results' },
      results.map((result, index) =>
        h(
          'button',
          {
            key: `${result.bookId || 'book'}-${Number.isInteger(result.chapterIndex) ? result.chapterIndex : index}`,
            type: 'button',
            className: 'rd-search-result',
            onClick: () => void choose(result),
          },
          h(
            'span',
            { className: 'rd-search-result-meta' },
            h('span', { className: 'rd-search-result-book' }, String(result.bookTitle || tr('未命名书籍', 'Untitled book'))),
            h('span', { className: 'rd-search-result-chapter' }, noteChapterLabel(result)),
          ),
          h('span', { className: 'rd-search-result-snippet' }, searchHighlight(result.snippet, q)),
        ),
      ),
    )
  }

  const status = loading
    ? tr('搜索中…', 'Searching…')
    : q
      ? tr(`共 ${results.length} 条结果`, `${results.length} results`)
      : tr('Esc 关闭', 'Esc to close')

  return h(
    'div',
    { className: 'rd-search-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('搜索', 'Search') },
    h('div', { className: 'rd-search-mask', onClick: () => actions.closeSearch() }),
    h(
      'div',
      { className: 'rd-search-panel' },
      h(
        'div',
        { className: 'rd-search-head' },
        h(Icon, { name: 'search', size: 16 }),
        h('input', {
          ref: inputRef,
          className: 'rd-search-input',
          type: 'search',
          value: query,
          placeholder: tr('搜索书名与正文…', 'Search titles and text…'),
          'aria-label': tr('搜索书名与正文', 'Search titles and text'),
          onChange: (event) => {
            const value = event.target.value
            setQuery(value)
            runSearch(value)
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter') runSearch.flush(query)
          },
        }),
        h(IconButton, { icon: 'close', label: tr('关闭搜索', 'Close search'), onClick: () => actions.closeSearch() }),
      ),
      h('div', { className: 'rd-search-body' }, body),
      h('div', { className: 'rd-search-status' }, status),
    ),
  )
}

addStyles(`
.rd-notes-view { flex: 1; min-height: 0; overflow: auto; }
.rd-notes-layout { display: grid; grid-template-columns: 232px minmax(0, 1fr); gap: 18px; padding: 20px 24px 64px; max-width: 1180px; margin: 0 auto; }
.rd-notes-rail { position: sticky; top: 8px; align-self: start; display: flex; flex-direction: column; gap: 6px; }
.rd-notes-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: 1px solid transparent;
  border-radius: var(--rd-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  text-align: left;
  padding: 8px 10px;
  cursor: pointer;
}
.rd-notes-pill:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.rd-notes-pill:disabled { opacity: .5; cursor: default; }
.rd-notes-pill.is-active { background: color-mix(in oklab, var(--dsw-alias-brand-primary) 12%, transparent); color: var(--dsw-alias-brand-primary); font-weight: 600; }
.rd-notes-pill-label { flex: 1; }
.rd-notes-pill-count { font-size: 11px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-radius: 999px; padding: 0 6px; font-variant-numeric: tabular-nums; }
.rd-notes-rail-sep { height: 1px; background: var(--dsw-alias-border-l1); margin: 6px 0; }
.rd-notes-rail-loading { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); padding: 0 2px; }

.rd-notes-main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.rd-notes-list-head { display: flex; align-items: center; gap: 10px; min-height: 26px; }
.rd-notes-list-count { flex: 1; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.rd-notes-list { display: flex; flex-direction: column; gap: 12px; }
.rd-notes-loading { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 60px 20px; color: var(--dsw-alias-label-secondary); font-size: 13px; }

.rd-notes-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--rd-radius-md);
  background: var(--dsw-alias-bg-layer-1);
}
.rd-notes-card-head { display: flex; align-items: baseline; gap: 8px; }
.rd-notes-card-titles { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.rd-notes-card-book { font-size: 13px; font-weight: 600; }
.rd-notes-card-chapter { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.rd-notes-card-date { margin-left: auto; flex: none; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.rd-notes-card-quote {
  margin: 0;
  border-left: 3px solid var(--dsw-alias-brand-primary);
  padding: 2px 0 2px 10px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
.rd-notes-card-qa { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 6px; font-size: 13px; line-height: 1.7; }
.rd-notes-card-qa-label { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); padding-top: 2px; }
.rd-notes-card-q { word-break: break-word; }
.rd-notes-card-answer-excerpt { color: var(--dsw-alias-label-secondary); }
.rd-notes-card-note {
  display: flex;
  gap: 8px;
  align-items: baseline;
  background: var(--dsw-alias-bg-layer-2);
  border-radius: var(--rd-radius-sm);
  padding: 7px 10px;
  font-size: 12.5px;
  line-height: 1.65;
}
.rd-notes-card-note-label { flex: none; font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.rd-notes-card-note-text { white-space: pre-wrap; word-break: break-word; }
.rd-notes-card-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.rd-notes-tag { font-size: 11px; color: var(--dsw-alias-brand-primary); background: color-mix(in oklab, var(--dsw-alias-brand-primary) 10%, transparent); border-radius: 999px; padding: 2px 8px; }
.rd-notes-card-actions { display: flex; flex-wrap: wrap; gap: 2px; padding-top: 6px; border-top: 1px solid var(--dsw-alias-border-l1); }
.rd-notes-danger { color: var(--dsw-alias-state-error-primary); }
.rd-notes-quote-block {
  margin: 0 0 14px;
  padding: 8px 12px;
  border-left: 3px solid var(--dsw-alias-brand-primary);
  border-radius: 0 var(--rd-radius-sm) var(--rd-radius-sm) 0;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  max-height: 160px;
  overflow: auto;
}

.rd-notes-drawer {
  position: absolute;
  z-index: 44;
  top: max(52px, calc(30px + var(--dsh-frame-top-clearance, 0px)));
  right: 0;
  bottom: 0;
  width: 380px;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-layer-1);
  border-left: 1px solid var(--dsw-alias-border-l1);
  box-shadow: -12px 0 28px rgba(0, 0, 0, .10);
}
.rd-notes-drawer-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px 10px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.rd-notes-drawer-title { flex: 1; display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 14px; font-weight: 600; }
.rd-notes-drawer-count { font-size: 11px; font-weight: 500; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-radius: 999px; padding: 0 6px; }
.rd-notes-drawer-body { flex: 1; min-height: 0; overflow: auto; padding: 12px 14px 24px; }
.rd-notes-drawer-list { display: flex; flex-direction: column; gap: 10px; }
.rd-notes-card.is-compact { padding: 12px; gap: 6px; background: var(--dsw-alias-bg-base); }

.rd-search-overlay { position: absolute; inset: 0; z-index: 58; display: flex; align-items: flex-start; justify-content: center; padding: 8vh 20px 24px; }
.rd-search-mask { position: absolute; inset: 0; background: rgba(0, 0, 0, .32); }
.rd-search-panel {
  position: relative;
  width: 100%;
  max-width: 720px;
  max-height: 80%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--rd-radius-lg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, .3);
}
.rd-search-head { flex: none; display: flex; align-items: center; gap: 9px; padding: 12px 12px 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.rd-search-input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
}
.rd-search-input::placeholder { color: var(--dsw-alias-label-secondary); }
.rd-search-input::-webkit-search-cancel-button { display: none; }
.rd-search-body { flex: 1; min-height: 0; overflow: auto; }
.rd-search-results { display: flex; flex-direction: column; padding: 6px; }
.rd-search-result {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  border: 0;
  border-radius: var(--rd-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  text-align: left;
  padding: 10px 12px;
  cursor: pointer;
}
.rd-search-result:hover, .rd-search-result:focus-visible { background: var(--dsw-alias-bg-layer-2); }
.rd-search-result-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.rd-search-result-book { font-weight: 600; color: var(--dsw-alias-label-primary); }
.rd-search-result-snippet { font-size: 13px; line-height: 1.65; word-break: break-word; }
.rd-search-mark { background: color-mix(in oklab, var(--dsw-alias-brand-primary) 22%, transparent); color: inherit; border-radius: 2px; padding: 0 1px; }
.rd-search-status { flex: none; padding: 8px 14px; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.rd-search-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 48px 24px; text-align: center; color: var(--dsw-alias-label-secondary); }
.rd-search-empty-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.rd-search-empty-hint { font-size: 12px; line-height: 1.6; max-width: 420px; }

@media (max-width: 900px) {
  .rd-notes-layout { grid-template-columns: 1fr; padding: 14px; }
  .rd-notes-rail { position: static; }
}
@media (max-width: 640px) {
  .rd-notes-drawer { width: 100%; }
}
`)
