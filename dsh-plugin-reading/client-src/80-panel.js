/**
 * The reading main panel: page chrome, tab dispatch, sidebar entry, and the
 * hidden file input that imports EPUBs.
 *
 * Views are separate parts of this bundle: 40-shelf (bookshelf), 50-reader
 * (reader + table of contents + settings), 60-ask (selection toolbar and Q&A
 * drawer), 70-notes (notes list and editor).
 */

/** Header for the shelf/notes page. */
function LibraryHeader({ state, actions, onImport }) {
  return h(
    'header',
    { className: 'rd-header' },
    h('div', { className: 'rd-header-title' }, tr('阅读', 'Reading')),
    h('div', { className: 'rd-header-sub' }, tr(`${state.shelf.books.length} 本 · ${state.shelf.notesCount} 条笔记`, `${state.shelf.books.length} books · ${state.shelf.notesCount} notes`)),
    h('div', { className: 'rd-header-spacer' }),
    h(
      'div',
      { className: 'rd-header-actions' },
      h(IconButton, { icon: 'search', label: tr('搜索书籍内容', 'Search inside books'), onClick: () => { actions.setView('shelf'); actions.openSearch() } }),
      h(IconButton, { icon: 'refresh', label: tr('刷新', 'Refresh'), onClick: () => void actions.refreshShelf() }),
      h(Button, { variant: 'primary', icon: 'upload', onClick: onImport, disabled: state.importing }, state.importing ? tr('导入中…', 'Importing…') : tr('导入 EPUB', 'Import EPUB')),
    ),
  )
}

/** Header for the reader. */
function ReaderHeader({ state, actions }) {
  const current = state.current
  const book = current?.book
  const chapterTitle = current?.chapter?.title || current?.toc?.[current?.chapterIndex || 0]?.title || ''
  return h(
    'header',
    { className: 'rd-header' },
    h(IconButton, { icon: 'back', label: tr('返回书架', 'Back to shelf'), onClick: () => actions.closeBook() }),
    h(
      'div',
      { className: 'rd-reader-heading' },
      h('div', { className: 'rd-header-title rd-ellipsis', title: book?.title }, book?.title || ''),
      chapterTitle ? h('div', { className: 'rd-header-sub rd-ellipsis', title: chapterTitle }, chapterTitle) : null,
    ),
    h('div', { className: 'rd-header-spacer' }),
    h(
      'div',
      { className: 'rd-header-actions' },
      h(IconButton, {
        icon: 'search',
        label: tr('在本书中搜索', 'Search this book'),
        onClick: () => actions.openSearch(),
      }),
      h(IconButton, {
        icon: 'toc',
        label: tr('目录', 'Contents'),
        active: state.reading.tocOpen,
        onClick: () => actions.setReadingPanel({ tocOpen: !state.reading.tocOpen }),
      }),
      h(IconButton, {
        icon: 'bookmark',
        label: tr('书签', 'Bookmark'),
        onClick: () => void actions.toggleBookmark(),
      }),
      h(IconButton, {
        icon: 'note',
        label: tr('笔记', 'Notes'),
        active: state.reading.notesOpen,
        onClick: () => actions.setReadingPanel({ notesOpen: !state.reading.notesOpen }),
      }),
      h(IconButton, {
        icon: 'settings',
        label: tr('阅读设置', 'Reading settings'),
        active: state.reading.settingsOpen,
        onClick: () => actions.setReadingPanel({ settingsOpen: !state.reading.settingsOpen }),
      }),
    ),
  )
}

/** Tabs shown outside the reader. */
function LibraryTabs({ state, actions }) {
  return h(
    'nav',
    { className: 'rd-tabs' },
    h(
      'button',
      { type: 'button', className: cx('rd-tab', state.view === 'shelf' && 'is-active'), onClick: () => actions.setView('shelf') },
      tr('书架', 'Bookshelf'),
    ),
    h(
      'button',
      { type: 'button', className: cx('rd-tab', state.view === 'notes' && 'is-active'), onClick: () => actions.setView('notes') },
      tr('笔记', 'Notes'),
    ),
    h('div', { className: 'rd-header-spacer' }),
    state.view === 'notes'
      ? h(Button, { variant: 'ghost', size: 'sm', icon: 'download', onClick: () => void actions.exportNotes() }, tr('导出 Markdown', 'Export Markdown'))
      : null,
  )
}

/** One full page body. */
function ReadingBody({ state, actions, api }) {
  if (state.status === 'loading') {
    return h('div', { className: 'rd-body' }, h('div', { className: 'rd-center' }, h(Spinner, { size: 22 }), h('span', { className: 'rd-muted' }, tr('正在打开书架…', 'Opening the library…'))))
  }
  if (state.status === 'error') {
    return h(
      'div',
      { className: 'rd-body' },
      h(
        'div',
        { className: 'rd-center' },
        h(Empty, {
          icon: 'book',
          title: tr('书架暂时打不开', 'The library is unavailable'),
          description: state.error,
          action: h(Button, { variant: 'primary', icon: 'refresh', onClick: () => void actions.bootstrap() }, tr('重试', 'Retry')),
        }),
      ),
    )
  }
  if (state.view === 'reader' && state.current) {
    return h(ReaderView, { state, actions, api })
  }
  if (state.view === 'notes') {
    return h(NotesView, { state, actions })
  }
  return h(ShelfView, { state, actions, api })
}

/** The root slot component registered as the `reading` main panel. */
function ReadingPanel() {
  const state = useReading()
  const actions = READING_ACTIONS
  const api = useMemo(() => READING_API, [])
  const inputRef = useRef(null)
  const [dragActive, setDragActive] = useState(false)

  useEffect(() => {
    void actions.bootstrap()
  }, [actions])

  useEffect(() => {
    return () => {
      actions.flushProgress()
    }
  }, [actions])

  const onImportClick = useCallback(() => inputRef.current?.click(), [])
  const onFiles = useCallback(
    (files) => {
      const file = files && files[0]
      if (!file) return
      if (!/\.epub$/i.test(file.name)) {
        actions.toast(tr('目前只支持 EPUB 文件。', 'Only EPUB files are supported for now.'), 'error')
        return
      }
      void actions.importFile(file)
    },
    [actions],
  )

  useEffect(() => {
    const onWindowDragOver = (event) => {
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes('Files')) return
      event.preventDefault()
      setDragActive(true)
    }
    const onWindowDragLeave = (event) => {
      if (event.relatedTarget) return
      setDragActive(false)
    }
    const onWindowDrop = (event) => {
      if (!event.dataTransfer || !event.dataTransfer.files || event.dataTransfer.files.length === 0) return
      event.preventDefault()
      setDragActive(false)
      onFiles(event.dataTransfer.files)
    }
    window.addEventListener('dragover', onWindowDragOver)
    window.addEventListener('dragleave', onWindowDragLeave)
    window.addEventListener('drop', onWindowDrop)
    return () => {
      window.removeEventListener('dragover', onWindowDragOver)
      window.removeEventListener('dragleave', onWindowDragLeave)
      window.removeEventListener('drop', onWindowDrop)
    }
  }, [onFiles])

  return h(
    'div',
    { className: 'rd-root', 'data-view': state.view },
    h(StyleSheet),
    state.view === 'reader' && state.current
      ? h(ReaderHeader, { state, actions })
      : h(LibraryHeader, { state, actions, onImport: onImportClick }),
    state.view !== 'reader' ? h(LibraryTabs, { state, actions }) : null,
    h(ReadingBody, { state, actions, api }),
    state.search.open ? h(SearchOverlay, { state, actions }) : null,
    dragActive
      ? h(
          'div',
          { className: 'rd-dropzone' },
          h('div', { className: 'rd-dropzone-card' }, h(Icon, { name: 'upload', size: 26 }), h('div', null, tr('松手导入 EPUB', 'Drop the EPUB to import'))),
        )
      : null,
    h('input', {
      ref: inputRef,
      type: 'file',
      accept: '.epub,application/epub+zip',
      style: { display: 'none' },
      onChange: (event) => {
        onFiles(event.target.files)
        event.target.value = ''
      },
    }),
    h(Toast, { toast: state.toast, onDismiss: actions.dismissToast }),
  )
}

/** Left-sidebar entry: the icon shown in the global panel list. */
function ReadingSidebarIcon() {
  return h(
    'span',
    { className: 'rd-sidebar-icon', 'aria-hidden': true },
    h(Icon, { name: 'bookOpen', size: 17 }),
  )
}

addStyles(`
.rd-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; }
.rd-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rd-reader-heading { display: flex; flex-direction: column; min-width: 0; max-width: 46%; }
.rd-sidebar-icon { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; }
.rd-dropzone { position: fixed; inset: 0; z-index: 70; background: color-mix(in oklab, var(--dsw-alias-brand-primary) 10%, rgba(0,0,0,.25)); display: flex; align-items: center; justify-content: center; pointer-events: none; }
.rd-dropzone-card { display: flex; align-items: center; gap: 10px; padding: 18px 26px; border-radius: var(--rd-radius-lg); background: var(--dsw-alias-bg-overlay); border: 1.5px dashed var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); font-size: 14px; box-shadow: 0 12px 32px rgba(0,0,0,.2); }
`)
