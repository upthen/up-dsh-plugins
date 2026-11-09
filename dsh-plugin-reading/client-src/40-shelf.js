/**
 * 40-shelf.js — the bookshelf view.
 *
 * Rendered inside `.rd-body` (owned by 80-panel). Fills the row, keeps the toolbar
 * fixed and scrolls the card grid itself. Sorting is purely client-side; the
 * selected mode only lives in component state.
 *
 * Delete is the one place where a view calls `api.rpc` directly: the store has no
 * `deleteBook` action, and this RPC is followed by `actions.refreshShelf()` plus a
 * toast, so the store ends up consistent. Everything else goes through `actions`.
 */

/** Cover tints for books without a usable cover image (percent of brand mixed in). */
const RD_SHELF_TINT_MIN = 8
const RD_SHELF_TINT_RANGE = 27

/** Density presets: grid column minimum width in px. */
const RD_SHELF_DENSITY = { standard: '160px', wide: '200px' }

/** Human "last read" label for a card's meta line. */
function shelfRelativeTime(value) {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return tr('尚未阅读', 'Not started')
  const diff = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return tr('刚刚', 'Just now')
  if (minutes < 60) return tr(`${minutes} 分钟前`, `${minutes} min ago`)
  const hours = Math.floor(diff / 3600000)
  if (hours < 24) return tr(`${hours} 小时前`, `${hours} h ago`)
  const days = Math.floor(diff / 86400000)
  if (days < 7) return tr(`${days} 天前`, `${days} d ago`)
  return formatDate(timestamp)
}

/** Deterministic tint percentage from a book id, so covers stay stable across renders. */
function shelfCoverTint(id) {
  const text = String(id || '')
  let hash = 0
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) >>> 0
  return RD_SHELF_TINT_MIN + (hash % RD_SHELF_TINT_RANGE)
}

/** Cover image with a typographic fallback; falls back on load errors too. */
function ShelfCover({ book, api }) {
  const [failed, setFailed] = useState(false)
  const title = (book && book.title) || tr('未命名书籍', 'Untitled')
  const author = (book && typeof book.author === 'string' && book.author.trim()) || ''
  const source =
    !failed && book && book.cover && api && typeof api.coverUrl === 'function' ? api.coverUrl(book.id) : ''
  if (source) {
    return h(
      'div',
      { className: 'rd-shelf-cover' },
      h('img', {
        className: 'rd-shelf-cover-img',
        src: source,
        alt: title,
        loading: 'lazy',
        decoding: 'async',
        onError: () => setFailed(true),
      }),
    )
  }
  const tint = shelfCoverTint(book && book.id)
  return h(
    'div',
    {
      className: 'rd-shelf-cover rd-shelf-cover-fallback',
      'aria-hidden': true,
      style: {
        background: `linear-gradient(150deg, color-mix(in oklab, var(--dsw-alias-brand-primary) ${tint}%, var(--dsw-alias-bg-layer-2)), var(--dsw-alias-bg-layer-2))`,
      },
    },
    h('span', { className: 'rd-shelf-cover-title' }, title),
    author ? h('span', { className: 'rd-shelf-cover-author' }, author) : null,
  )
}

/** One shelf card: cover, metadata, progress, and hover/focus actions. */
function ShelfBookCard({ book, actions, api, onRequestDelete }) {
  const title = (book && book.title) || tr('未命名书籍', 'Untitled')
  const author = (book && typeof book.author === 'string' && book.author.trim()) || ''
  const chapterCount = Math.max(0, Math.trunc(Number(book && book.chapterCount) || 0))
  const progress = book && book.progress && typeof book.progress === 'object' ? book.progress : {}
  const percent = clamp(Number(progress.percent) || 0, 0, 1)
  const started = percent > 0 || Number(book && book.openedCount) > 0
  const chapterLabel =
    chapterCount > 0
      ? chapterCount === 1
        ? tr('1 章', '1 chapter')
        : tr(`${chapterCount} 章`, `${chapterCount} chapters`)
      : tr('暂无章节', 'No chapters')
  return h(
    'article',
    { className: 'rd-shelf-card' },
    h(ShelfCover, { book, api }),
    h(
      'div',
      { className: 'rd-shelf-card-body' },
      h('div', { className: 'rd-shelf-card-title', title }, title),
      h('div', { className: 'rd-shelf-card-author' }, author || tr('未知作者', 'Unknown author')),
      h(
        'div',
        { className: 'rd-shelf-card-meta' },
        h('span', null, chapterLabel),
        h('span', null, shelfRelativeTime(book && book.lastReadAt)),
      ),
      h(
        'div',
        { className: 'rd-shelf-card-progress' },
        h(Progress, { value: percent }),
        h('span', { className: 'rd-shelf-percent' }, `${Math.round(percent * 100)}%`),
      ),
    ),
    h('button', {
      type: 'button',
      className: 'rd-shelf-card-open',
      onClick: () => void actions.openBook(book.id),
      title: tr(`打开《${title}》`, `Open "${title}"`),
      'aria-label': tr(`打开《${title}》`, `Open "${title}"`),
    }),
    h(
      'div',
      { className: 'rd-shelf-card-actions' },
      h(
        Button,
        {
          variant: 'primary',
          size: 'sm',
          icon: 'bookOpen',
          title: started ? tr('继续阅读', 'Continue reading') : tr('开始阅读', 'Start reading'),
          onClick: () => void actions.openBook(book.id),
        },
        started ? tr('继续阅读', 'Continue') : tr('开始阅读', 'Start'),
      ),
      h(IconButton, {
        icon: 'trash',
        label: tr(`删除《${title}》`, `Delete "${title}"`),
        className: 'rd-shelf-delete',
        onClick: () => onRequestDelete(book),
      }),
    ),
  )
}

/** Empty shelf: import guidance, window drag hint and the library location. */
function ShelfEmptyState({ actions, libraryDir }) {
  const inputRef = useRef(null)
  const onFiles = (event) => {
    const input = event && event.target
    const file = input && input.files && input.files[0]
    if (input) input.value = ''
    if (!file) return
    if (!/\.epub$/i.test(String(file.name || ''))) {
      actions.toast(tr('目前只支持 EPUB 文件。', 'Only EPUB files are supported for now.'), 'error')
      return
    }
    void actions.importFile(file)
  }
  return h(
    'div',
    { className: 'rd-shelf-empty' },
    h(Empty, {
      icon: 'bookOpen',
      title: tr('书架还是空的', 'Your shelf is empty'),
      description: tr(
        '把 EPUB 文件拖到窗口任意位置即可导入；也可以点下面的按钮，或使用右上角的「导入 EPUB」。书库保存在 Host 上，换浏览器也不会丢。',
        'Drag an EPUB anywhere onto the window to import, or use the button below (or “Import EPUB” in the header). Books live on the Host, so they survive browser changes.',
      ),
      action: h(
        Button,
        {
          variant: 'primary',
          icon: 'upload',
          title: tr('导入 EPUB 文件', 'Import an EPUB file'),
          onClick: () => inputRef.current?.click(),
        },
        tr('导入 EPUB', 'Import EPUB'),
      ),
    }),
    libraryDir
      ? h(
          'div',
          { className: 'rd-shelf-library', title: libraryDir },
          tr(`书库位置：${libraryDir}`, `Library: ${libraryDir}`),
        )
      : null,
    h('input', {
      ref: inputRef,
      type: 'file',
      accept: '.epub,application/epub+zip',
      style: { display: 'none' },
      onChange: onFiles,
    }),
  )
}

/** The bookshelf page body. */
function ShelfView({ state, actions, api }) {
  const shelf = state.shelf && typeof state.shelf === 'object' ? state.shelf : {}
  const books = Array.isArray(shelf.books) ? shelf.books : []
  const libraryDir = typeof shelf.libraryDir === 'string' ? shelf.libraryDir : ''
  const [sort, setSort] = useState('recent')
  const [density, setDensity] = useState('standard')
  const [pendingDelete, setPendingDelete] = useState(null)
  const [deleting, setDeleting] = useState(false)

  const sortedBooks = useMemo(() => {
    const list = books.slice()
    if (sort === 'title') {
      list.sort((left, right) => String(left.title || '').localeCompare(String(right.title || ''), 'zh-Hans-CN'))
      return list
    }
    if (sort === 'added') {
      list.sort((left, right) => (Number(right.addedAt) || 0) - (Number(left.addedAt) || 0))
      return list
    }
    list.sort((left, right) => {
      const leftRead = Number(left.lastReadAt) || 0
      const rightRead = Number(right.lastReadAt) || 0
      if (leftRead !== rightRead) return rightRead - leftRead
      return (Number(right.addedAt) || 0) - (Number(left.addedAt) || 0)
    })
    return list
  }, [books, sort])

  const closeDelete = useCallback(() => {
    if (deleting) return
    setPendingDelete(null)
  }, [deleting])

  /** Delete one book through the Host RPC, then refresh the shelf snapshot. */
  const confirmDelete = useCallback(async () => {
    const book = pendingDelete
    if (!book || !book.id || deleting) return
    setDeleting(true)
    try {
      await api.rpc('book/delete', { id: book.id })
      setPendingDelete(null)
      actions.toast(tr(`已删除《${book.title || '未命名书籍'}》`, `Deleted "${book.title || 'Untitled'}"`))
      await actions.refreshShelf()
    } catch (error) {
      actions.fail(error)
    } finally {
      setDeleting(false)
    }
  }, [actions, api, deleting, pendingDelete])

  const sortOptions = [
    { value: 'recent', label: tr('最近阅读', 'Recent') },
    { value: 'added', label: tr('导入时间', 'Added') },
    { value: 'title', label: tr('书名', 'Title') },
  ]

  return h(
    'div',
    { className: 'rd-shelf' },
    books.length > 0
      ? h(
          'div',
          { className: 'rd-shelf-toolbar' },
          h('span', { className: 'rd-shelf-count' }, tr(`${books.length} 本`, `${books.length} ${books.length === 1 ? 'book' : 'books'}`)),
          h('span', { className: 'rd-shelf-toolbar-spacer' }),
          h(
            Button,
            {
              variant: 'secondary',
              size: 'sm',
              icon: 'search',
              title: tr('搜索所有书籍正文', 'Search inside all books'),
              onClick: () => actions.openSearch(),
            },
            tr('搜索正文', 'Search text'),
          ),
          h(Segmented, { value: sort, options: sortOptions, onChange: setSort, label: tr('排序方式', 'Sort by') }),
          h(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              title: tr('切换卡片密度', 'Toggle card density'),
              onClick: () => setDensity((current) => (current === 'wide' ? 'standard' : 'wide')),
            },
            density === 'wide' ? tr('宽松', 'Wide') : tr('标准', 'Standard'),
          ),
        )
      : null,
    state.importing
      ? h(
          'div',
          { className: 'rd-shelf-importing', role: 'status' },
          h(Spinner, { size: 14 }),
          tr('正在导入 EPUB，请稍候…', 'Importing EPUB…'),
        )
      : null,
    books.length === 0
      ? h(ShelfEmptyState, { actions, libraryDir })
      : h(
          'div',
          { className: 'rd-shelf-scroll' },
          h(
            'div',
            {
              className: 'rd-shelf-grid',
              style: { '--rd-shelf-min': RD_SHELF_DENSITY[density] || RD_SHELF_DENSITY.standard },
            },
            sortedBooks.map((book) =>
              h(ShelfBookCard, {
                key: book.id,
                book,
                actions,
                api,
                onRequestDelete: setPendingDelete,
              }),
            ),
          ),
        ),
    h(Dialog, {
      open: Boolean(pendingDelete),
      onClose: closeDelete,
      width: 440,
      title: tr('删除这本书？', 'Delete this book?'),
      description: pendingDelete
        ? tr(
            `《${pendingDelete.title}》的正文、封面和阅读进度会从书库中删除，相关的问答笔记也会一并删除。此操作无法撤销。`,
            `"${pendingDelete.title}" and its cover, reading progress and related Q&A notes will be removed from the library. This cannot be undone.`,
          )
        : '',
      footer: [
        h(
          Button,
          { key: 'cancel', variant: 'ghost', onClick: closeDelete, disabled: deleting },
          tr('取消', 'Cancel'),
        ),
        h(
          Button,
          { key: 'delete', variant: 'danger', icon: 'trash', onClick: () => void confirmDelete(), disabled: deleting },
          deleting ? tr('删除中…', 'Deleting…') : tr('删除', 'Delete'),
        ),
      ],
    }),
  )
}

addStyles(`
.rd-shelf { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.rd-shelf-toolbar {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 24px; flex: none; flex-wrap: wrap;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
}
.rd-shelf-count { font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.rd-shelf-toolbar-spacer { flex: 1; min-width: 8px; }
.rd-shelf-importing {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 24px; flex: none; font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  background: color-mix(in oklab, var(--dsw-alias-brand-primary) 9%, transparent);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.rd-shelf-scroll { flex: 1; min-height: 0; overflow: auto; }
.rd-shelf-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--rd-shelf-min, 160px), 1fr));
  gap: 16px; padding: 20px 24px 56px;
  max-width: 1180px; margin: 0 auto;
}
.rd-shelf-card {
  position: relative; display: flex; flex-direction: column; min-width: 0;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--rd-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
  transition: border-color .12s ease, box-shadow .12s ease, transform .12s ease;
}
.rd-shelf-card:hover {
  border-color: color-mix(in oklab, var(--dsw-alias-brand-primary) 38%, var(--dsw-alias-border-l1));
  box-shadow: 0 4px 14px rgba(0, 0, 0, .08);
  transform: translateY(-1px);
}
.rd-shelf-card-open {
  position: absolute; inset: 0; z-index: 1;
  border: 0; padding: 0; margin: 0; background: transparent; cursor: pointer;
  border-radius: var(--rd-radius-md);
}
.rd-shelf-card-open:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
.rd-shelf-cover {
  position: relative; display: block; width: 100%;
  aspect-ratio: 3 / 4; overflow: hidden;
  background: var(--dsw-alias-bg-layer-2);
}
.rd-shelf-cover-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.rd-shelf-cover-fallback {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 8px; padding: 14px; text-align: center;
}
.rd-shelf-cover-title {
  font-size: 13px; font-weight: 600; line-height: 1.45;
  color: var(--dsw-alias-label-primary); word-break: break-word;
  display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
}
.rd-shelf-cover-author {
  font-size: 11px; color: var(--dsw-alias-label-secondary); word-break: break-word;
  display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden;
}
.rd-shelf-card-body {
  display: flex; flex-direction: column; gap: 3px;
  padding: 10px 12px 12px; min-width: 0;
}
.rd-shelf-card-title {
  font-size: 13px; font-weight: 600; line-height: 1.4;
  color: var(--dsw-alias-label-primary); word-break: break-word;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.rd-shelf-card-author {
  font-size: 12px; color: var(--dsw-alias-label-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rd-shelf-card-meta {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-top: 2px; font-size: 11px; color: var(--dsw-alias-label-secondary);
}
.rd-shelf-card-meta > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rd-shelf-card-progress { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
.rd-shelf-card-progress .rd-progress { flex: 1; }
.rd-shelf-percent {
  flex: none; min-width: 30px; text-align: right;
  font-size: 11px; color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.rd-shelf-card-actions {
  position: absolute; top: 0; left: 0; right: 0; aspect-ratio: 3 / 4;
  z-index: 2; display: flex; align-items: flex-end; justify-content: space-between;
  gap: 6px; padding: 8px; opacity: 0; pointer-events: none;
  transition: opacity .12s ease;
  background: linear-gradient(to top, color-mix(in oklab, var(--dsw-alias-bg-base) 88%, transparent), transparent 62%);
}
.rd-shelf-card:hover .rd-shelf-card-actions,
.rd-shelf-card:focus-within .rd-shelf-card-actions { opacity: 1; pointer-events: auto; }
.rd-shelf-delete {
  background: var(--dsw-alias-bg-layer-1);
  border-color: var(--dsw-alias-border-l1);
  color: var(--dsw-alias-state-error-primary);
}
.rd-shelf-delete:hover {
  background: color-mix(in oklab, var(--dsw-alias-state-error-primary) 12%, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-state-error-primary);
}
.rd-shelf-empty {
  flex: 1; min-height: 0; overflow: auto;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; padding: 32px 24px;
}
.rd-shelf-library {
  max-width: 560px; text-align: center; word-break: break-all;
  font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary);
}
@media (max-width: 720px) {
  .rd-shelf-toolbar { padding: 10px 14px; }
  .rd-shelf-grid { padding: 14px 14px 40px; gap: 12px; }
}
`)
