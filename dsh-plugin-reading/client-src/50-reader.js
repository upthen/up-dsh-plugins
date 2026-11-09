/**
 * 50-reader.js — the reading surface.
 *
 * Layout: a self-scrolling center column with the article, an optional left table
 * of contents drawer, the reading-settings dialog, and the selection/ask/notes
 * layers owned by 60-ask.js and 70-notes.js.
 *
 * The outer `.rd-reader` is deliberately NOT a positioned box: those sibling
 * layers position themselves absolutely against `.rd-root` (see CONTRACT.md), so
 * only the inner `.rd-reader-main` wrapper is positioned — it hosts the TOC
 * overlay and the loading indicators.
 */

/** Defaults mirroring host `DEFAULT_SETTINGS`; used until the first shelf snapshot arrives. */
const RD_READER_DEFAULT_SETTINGS = Object.freeze({
  fontSize: 19,
  lineHeight: 1.9,
  fontFamily: 'serif',
  theme: 'paper',
  contentWidth: 720,
})

/** Font stacks keyed by the settings value. */
const RD_READER_FONT_STACKS = Object.freeze({
  serif: "Georgia, 'Songti SC', 'SimSun', serif",
  sans: "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  kai: "'Kaiti SC', 'KaiTi', serif",
  song: "'Songti SC', 'SimSun', serif",
})

/** Skeleton line widths for the chapter loading placeholder (percent). */
const RD_READER_SKELETON_WIDTHS = [100, 96, 88, 100, 92, 84, 97, 90]

/** Leading heading text of a chapter, used to avoid printing the title twice. */
function rdReaderLeadHeadingText(blocks) {
  if (!Array.isArray(blocks)) return ''
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.t === 'blank') continue
    if (block.t !== 'h') return ''
    const runs = Array.isArray(block.runs) ? block.runs : []
    return runs
      .map((run) => (run && typeof run.text === 'string' ? run.text : ''))
      .join('')
      .trim()
  }
  return ''
}

/** Normalise a link label for matching against a table-of-contents title. */
function rdReaderNormalizeLinkText(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/[\s\u3000]+/g, '')
    .replace(/[.·…]+$/g, '')
    .replace(/[\s\u3000]*\d+$/g, '')
    .replace(/[「」『』《》〈〉（）()\[\]【】<>:：;；,，.。!！?？'"“”‘’、·—–-]/g, '')
    .trim()
}

/**
 * Resolve an EPUB-internal link to a chapter index by its label.
 *
 * EPUB contents pages are regular chapters whose entries carry relative `href`s
 * that are meaningless outside the book archive. Their labels are the chapter
 * titles, so the table of contents is the index: exact match first, then a
 * contained-title match for labels with extra decorations.
 */
function rdReaderFindTocIndex(label, toc) {
  const target = rdReaderNormalizeLinkText(label)
  if (!target || !Array.isArray(toc) || toc.length === 0) return -1
  const titles = toc.map((entry) => rdReaderNormalizeLinkText(entry && entry.title))
  const exact = titles.indexOf(target)
  if (exact >= 0) return exact
  if (target.length < 2) return -1
  for (let index = 0; index < titles.length; index += 1) {
    const title = titles[index]
    if (!title || title.length < 2) continue
    if (target.startsWith(title) || title.startsWith(target)) return index
  }
  return -1
}

/** Render one inline run (b/i/u/sup/sub/code/href/ruby) as nested elements. */
function rdReaderRenderRun(run, key, linkCtx) {
  if (!run || typeof run.text !== 'string' || run.text.length === 0) return null
  let content
  if (run.text === '\n') {
    content = h('br')
  } else if (run.text.indexOf('\n') !== -1) {
    content = run.text.split('\n').map((part, index) =>
      index === 0 ? part : h(React.Fragment, { key: `rdbr${index}` }, h('br'), part),
    )
  } else {
    content = run.text
  }
  if (run.ruby) content = h('ruby', null, content, h('rt', null, run.ruby))
  if (run.code) content = h('code', { className: 'rd-reader-code' }, content)
  if (run.href) {
    const ctx = linkCtx || {}
    const external = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(run.href)
    if (external) {
      content = h(
        'a',
        { href: run.href, target: '_blank', rel: 'noreferrer noopener', className: 'rd-reader-link is-external' },
        content,
      )
    } else {
      const targetIndex = rdReaderFindTocIndex(run.text, ctx.toc)
      if (targetIndex >= 0 && typeof ctx.onJump === 'function') {
        const targetTitle = ctx.toc[targetIndex] && ctx.toc[targetIndex].title
        content = h(
          'button',
          {
            type: 'button',
            className: 'rd-reader-link',
            title: typeof targetTitle === 'string' ? tr(`跳转到《${targetTitle}》`, `Go to "${targetTitle}"`) : tr('跳转到该章节', 'Go to this chapter'),
            onClick: (event) => {
              event.preventDefault()
              event.stopPropagation()
              ctx.onJump(targetIndex, 0)
            },
          },
          content,
        )
      } else {
        // An archive-relative link we cannot map to a chapter: keep the text,
        // never open a broken app URL in a new tab.
        content = h('span', { className: 'rd-reader-link is-unresolved', title: tr('本书内链（无法定位章节）', 'In-book link (chapter not found)') }, content)
      }
    }
  }
  if (run.sup) content = h('sup', null, content)
  if (run.sub) content = h('sub', null, content)
  if (run.u) content = h('u', null, content)
  if (run.i) content = h('em', null, content)
  if (run.b) content = h('strong', null, content)
  return h('span', { key, className: 'rd-reader-run' }, content)
}

/** Render a run list; missing/odd runs are skipped instead of throwing. */
function rdReaderRenderRuns(runs, linkCtx) {
  if (!Array.isArray(runs)) return null
  return runs.map((run, index) => rdReaderRenderRun(run, index, linkCtx))
}

/** Render nested block lists (quoted content). */
function rdReaderRenderBlocks(blocks, prefix, linkCtx) {
  if (!Array.isArray(blocks) || blocks.length === 0) return null
  return blocks.map((block, index) => rdReaderRenderBlock(block, index, prefix, linkCtx))
}

/** Render one block from the host block model (`h|p|quote|list|hr|img|blank`). */
function rdReaderRenderBlock(block, index, prefix, linkCtx) {
  if (!block || typeof block !== 'object') return null
  const key = `${prefix}${index}`
  switch (block.t) {
    case 'h': {
      const level = clamp(Math.trunc(Number(block.level) || 2), 1, 6)
      // NB: not `rd-reader-heading` — 80-panel uses that for the header title block.
      return h(`h${level}`, { key, className: 'rd-reader-content-heading' }, rdReaderRenderRuns(block.runs, linkCtx))
    }
    case 'p':
      return h('p', { key, className: 'rd-reader-p' }, rdReaderRenderRuns(block.runs, linkCtx))
    case 'quote':
      return h(
        'blockquote',
        { key, className: 'rd-reader-quote' },
        rdReaderRenderBlocks(block.blocks, `${key}-`, linkCtx),
      )
    case 'list': {
      const items = Array.isArray(block.items) ? block.items : []
      const tag = block.ordered ? 'ol' : 'ul'
      return h(
        tag,
        { key, className: cx('rd-reader-list', block.ordered && 'is-ordered') },
        items.map((item, itemIndex) =>
          h('li', { key: `${key}i${itemIndex}` }, rdReaderRenderRuns(item, linkCtx)),
        ),
      )
    }
    case 'hr':
      return h('hr', { key, className: 'rd-reader-hr' })
    case 'blank':
      return h('div', { key, className: 'rd-reader-blank', 'aria-hidden': true })
    case 'img': {
      if (typeof block.src !== 'string' || block.src.length === 0) return null
      const ctx = linkCtx || {}
      if (!ctx.api || typeof ctx.api.assetUrl !== 'function') return null
      const source = ctx.api.assetUrl(ctx.bookId, block.src)
      if (!source) return null
      return h('img', {
        key,
        className: 'rd-reader-img',
        src: source,
        alt: typeof block.alt === 'string' ? block.alt : '',
        loading: 'lazy',
        decoding: 'async',
      })
    }
    default: {
      // Forward compatible: unknown containers degrade to their nested blocks.
      if (Array.isArray(block.blocks)) {
        return h(
          'div',
          { key, className: 'rd-reader-nested' },
          rdReaderRenderBlocks(block.blocks, `${key}-`, linkCtx),
        )
      }
      if (Array.isArray(block.runs)) {
        return h('p', { key, className: 'rd-reader-p' }, rdReaderRenderRuns(block.runs, linkCtx))
      }
      return null
    }
  }
}

/** The chapter body: block model -> React tree. */
function ChapterContent({ blocks, api, bookId, toc, onJump }) {
  const empty = !Array.isArray(blocks) || blocks.length === 0
  const linkCtx = { api, bookId, toc, onJump }
  return h(
    'div',
    { className: 'rd-reader-blocks' },
    empty
      ? h('p', { className: 'rd-reader-empty' }, tr('本章没有可显示的内容。', 'This chapter has no displayable content.'))
      : rdReaderRenderBlocks(blocks, 'rdb', linkCtx),
  )
}

/** Memoised chapter body: scrolling updates `progress`, but blocks rarely change. */
const RD_READER_CHAPTER_MEMO = React.memo(ChapterContent)

/** Bookmark rows inside the table-of-contents drawer. */
function BookmarkList({ bookmarks, toc, onJump, onRemove }) {
  const list = Array.isArray(bookmarks) ? bookmarks : []
  return h(
    'div',
    { className: 'rd-reader-toc-bookmarks' },
    h('div', { className: 'rd-reader-toc-section' }, tr('书签', 'Bookmarks')),
    list.length === 0
      ? h(
          'div',
          { className: 'rd-reader-toc-empty' },
          tr('阅读时点顶部的书签按钮，就能把当前位置保存在这里。', 'Use the bookmark button while reading to pin your place here.'),
        )
      : list.map((bookmark, index) => {
          if (!bookmark || typeof bookmark !== 'object') return null
          const chapterNumber = Math.max(0, Math.trunc(Number(bookmark.chapterIndex) || 0)) + 1
          const tocTitle =
            toc && toc[bookmark.chapterIndex] && typeof toc[bookmark.chapterIndex].title === 'string'
              ? toc[bookmark.chapterIndex].title
              : ''
          const label =
            (typeof bookmark.label === 'string' && bookmark.label.trim()) ||
            (typeof bookmark.chapterTitle === 'string' && bookmark.chapterTitle.trim()) ||
            tocTitle ||
            tr(`第 ${chapterNumber} 章`, `Chapter ${chapterNumber}`)
          const meta = [tr(`第 ${chapterNumber} 章`, `Chapter ${chapterNumber}`)]
          if (bookmark.createdAt) meta.push(formatDate(bookmark.createdAt))
          return h(
            'div',
            { key: bookmark.id || index, className: 'rd-reader-bm-item' },
            h(
              'button',
              {
                type: 'button',
                className: 'rd-reader-bm-jump',
                title: tr('回到书签位置', 'Jump to bookmark'),
                onClick: () =>
                  onJump(Number(bookmark.chapterIndex) || 0, Number(bookmark.scrollRatio) || 0),
              },
              h('span', { className: 'rd-reader-bm-label' }, label),
              h('span', { className: 'rd-reader-bm-meta' }, meta.join(' · ')),
            ),
            h(IconButton, {
              icon: 'trash',
              size: 14,
              label: tr('删除书签', 'Delete bookmark'),
              className: 'rd-reader-bm-delete',
              onClick: () => onRemove(bookmark.id),
            }),
          )
        }),
  )
}

/** The left table-of-contents drawer (overlays the article column). */
function TocPanel({ current, open, actions, onJump }) {
  const listRef = useRef(null)
  const [removedIds, setRemovedIds] = useState([])
  const currentIndex = current ? Math.max(0, Math.trunc(Number(current.chapterIndex) || 0)) : 0
  const toc = current && Array.isArray(current.toc) ? current.toc : []

  // Keep the highlighted chapter visible when the drawer opens or the chapter changes.
  useEffect(() => {
    if (!open || !listRef.current) return undefined
    const timer = setTimeout(() => {
      const element = listRef.current ? listRef.current.querySelector('[data-rd-current="true"]') : null
      if (element && typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'nearest' })
    }, 0)
    return () => clearTimeout(timer)
  }, [open, currentIndex, toc.length])

  /**
   * The store exposes only the current chapter's bookmarks (`current.bookmarks`),
   * while `current.book.bookmarks` is the snapshot taken when the book was opened.
   * Merge both: the scoped list wins, the stale current-chapter slice is dropped,
   * and locally deleted ids are filtered so no ghost rows appear.
   */
  const bookmarks = useMemo(() => {
    if (!current) return []
    const seen = new Set()
    const removed = new Set(removedIds)
    const merged = []
    const push = (bookmark) => {
      if (!bookmark || typeof bookmark !== 'object') return
      const id = bookmark.id || `${bookmark.chapterIndex}:${bookmark.scrollRatio}:${bookmark.createdAt}`
      if (bookmark.id && removed.has(bookmark.id)) return
      if (seen.has(id)) return
      seen.add(id)
      merged.push(bookmark)
    }
    const full = current.book && Array.isArray(current.book.bookmarks) ? current.book.bookmarks : []
    const scoped = Array.isArray(current.bookmarks) ? current.bookmarks : []
    full.forEach((bookmark) => {
      if (bookmark && bookmark.chapterIndex !== currentIndex) push(bookmark)
    })
    scoped.forEach(push)
    merged.sort(
      (left, right) =>
        (Number(left.chapterIndex) || 0) - (Number(right.chapterIndex) || 0) ||
        (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0),
    )
    return merged
  }, [current, currentIndex, removedIds])

  const removeBookmark = useCallback(
    (id) => {
      if (!id) return
      setRemovedIds((previous) => (previous.indexOf(id) >= 0 ? previous : [...previous, id]))
      void actions.removeBookmark(id)
    },
    [actions],
  )

  if (!open || !current) return null
  const book = current.book || {}
  const title = typeof book.title === 'string' && book.title.length > 0 ? book.title : tr('未命名书籍', 'Untitled')

  return h(
    'aside',
    { className: 'rd-reader-toc', 'aria-label': tr('目录', 'Contents') },
    h(
      'div',
      { className: 'rd-reader-toc-head' },
      h(
        'div',
        { className: 'rd-reader-toc-book' },
        h('div', { className: 'rd-reader-toc-book-title', title }, title),
        h(
          'div',
          { className: 'rd-reader-toc-book-sub' },
          toc.length > 0 ? tr(`${toc.length} 章`, `${toc.length} chapters`) : tr('暂无目录', 'No contents'),
        ),
      ),
      h(IconButton, {
        icon: 'close',
        label: tr('关闭目录', 'Close contents'),
        onClick: () => actions.setReadingPanel({ tocOpen: false }),
      }),
    ),
    h(
      'div',
      { className: 'rd-reader-toc-list', ref: listRef },
      toc.length === 0
        ? h('div', { className: 'rd-reader-toc-empty' }, tr('这本书没有可用的目录。', 'This book has no usable contents.'))
        : toc.map((entry, index) => {
            const entryTitle =
              entry && typeof entry.title === 'string' && entry.title.trim().length > 0
                ? entry.title
                : tr(`第 ${index + 1} 章`, `Chapter ${index + 1}`)
            return h(
              'button',
              {
                key: index,
                type: 'button',
                className: cx('rd-reader-toc-item', index === currentIndex && 'is-active'),
                title: entryTitle,
                'aria-current': index === currentIndex ? 'true' : undefined,
                'data-rd-current': index === currentIndex ? 'true' : undefined,
                onClick: () => onJump(index, 0),
              },
              h('span', { className: 'rd-reader-toc-num' }, String(index + 1).padStart(2, '0')),
              h('span', { className: 'rd-reader-toc-title' }, entryTitle),
            )
          }),
    ),
    h(BookmarkList, { bookmarks, toc, onJump, onRemove: removeBookmark }),
  )
}

/** Memoised drawer: ignores scroll updates because only `current`/`open` matter. */
const RD_READER_TOC_MEMO = React.memo(TocPanel)

/** Previous/next chapter buttons plus whole-book progress. */
function ChapterNav({ currentIndex, chapterCount, percent, onPrev, onNext, disabled }) {
  const hasCount = chapterCount > 0
  const atStart = currentIndex <= 0
  const atEnd = hasCount ? currentIndex >= chapterCount - 1 : true
  const counter = hasCount
    ? tr(`第 ${currentIndex + 1} / ${chapterCount} 章`, `Chapter ${currentIndex + 1} of ${chapterCount}`)
    : tr(`第 ${currentIndex + 1} 章`, `Chapter ${currentIndex + 1}`)
  return h(
    'nav',
    { className: 'rd-reader-nav', 'aria-label': tr('章节导航', 'Chapter navigation') },
    h(
      Button,
      {
        variant: 'secondary',
        size: 'sm',
        icon: 'chevronLeft',
        title: tr('上一章', 'Previous chapter'),
        onClick: onPrev,
        disabled: disabled || atStart,
      },
      tr('上一章', 'Previous'),
    ),
    h(
      'div',
      { className: 'rd-reader-nav-mid' },
      h('div', { className: 'rd-reader-nav-count' }, counter),
      h(Progress, { value: percent, className: 'rd-reader-nav-progress' }),
    ),
    h(
      Button,
      {
        variant: 'secondary',
        size: 'sm',
        title: tr('下一章', 'Next chapter'),
        onClick: onNext,
        disabled: disabled || atEnd,
      },
      tr('下一章', 'Next'),
    ),
  )
}

/** Loading placeholder while the first chapter of a book is being fetched. */
function ReaderSkeleton() {
  return h(
    'div',
    { className: 'rd-reader-skeleton', 'aria-hidden': true },
    RD_READER_SKELETON_WIDTHS.map((width, index) =>
      h('div', { key: index, className: 'rd-reader-skeleton-line', style: { width: `${width}%` } }),
    ),
  )
}

/** Reading settings dialog: font size, line height, width, typeface and theme. */
function ReaderSettingsDialog({ settings, open, actions }) {
  const merged = { ...RD_READER_DEFAULT_SETTINGS, ...(settings && typeof settings === 'object' ? settings : {}) }
  const close = useCallback(() => actions.setReadingPanel({ settingsOpen: false }), [actions])
  const update = useCallback(
    (patch) => {
      void actions.setSettings(patch)
    },
    [actions],
  )
  const reset = useCallback(() => {
    void actions.setSettings({ ...RD_READER_DEFAULT_SETTINGS })
  }, [actions])

  const fontSize = Math.round(Number(merged.fontSize) || RD_READER_DEFAULT_SETTINGS.fontSize)
  const lineHeight = Math.round((Number(merged.lineHeight) || RD_READER_DEFAULT_SETTINGS.lineHeight) * 10) / 10
  const contentWidth = Math.round(Number(merged.contentWidth) || RD_READER_DEFAULT_SETTINGS.contentWidth)
  const fontValue =
    merged.fontFamily === 'sans' || merged.fontFamily === 'kai' || merged.fontFamily === 'song'
      ? merged.fontFamily
      : 'song'
  const themeValue = merged.theme === 'app' ? 'app' : 'paper'

  return h(
    Dialog,
    {
      open: Boolean(open),
      onClose: close,
      title: tr('阅读设置', 'Reading settings'),
      description: tr('改动会立即生效并自动保存。', 'Changes apply immediately and are saved automatically.'),
      width: 460,
      footer: [
        h(
          Button,
          { key: 'reset', variant: 'ghost', size: 'sm', icon: 'refresh', title: tr('恢复默认设置', 'Restore defaults'), onClick: reset },
          tr('重置', 'Reset'),
        ),
        h(Button, { key: 'done', variant: 'primary', onClick: close }, tr('完成', 'Done')),
      ],
    },
    h(
      'div',
      { className: 'rd-reader-settings' },
      h(Slider, {
        label: tr('字号', 'Font size'),
        value: fontSize,
        min: 14,
        max: 30,
        step: 1,
        suffix: 'px',
        onChange: (value) => update({ fontSize: value }),
      }),
      h(Slider, {
        label: tr('行距', 'Line height'),
        value: lineHeight,
        min: 1.4,
        max: 2.4,
        step: 0.1,
        onChange: (value) => update({ lineHeight: Math.round(value * 10) / 10 }),
      }),
      h(Slider, {
        label: tr('内容宽度', 'Content width'),
        value: contentWidth,
        min: 480,
        max: 1000,
        step: 20,
        suffix: 'px',
        onChange: (value) => update({ contentWidth: value }),
      }),
      h(
        'div',
        { className: 'rd-reader-setting-group' },
        h('span', { className: 'rd-field-label' }, tr('字体', 'Typeface')),
        h(Segmented, {
          value: fontValue,
          label: tr('字体', 'Typeface'),
          options: [
            { value: 'song', label: tr('宋体', 'Song') },
            { value: 'sans', label: tr('黑体', 'Sans') },
            { value: 'kai', label: tr('楷体', 'Kai') },
          ],
          onChange: (value) => update({ fontFamily: value }),
        }),
      ),
      h(
        'div',
        { className: 'rd-reader-setting-group' },
        h('span', { className: 'rd-field-label' }, tr('主题', 'Theme')),
        h(Segmented, {
          value: themeValue,
          label: tr('主题', 'Theme'),
          options: [
            { value: 'paper', label: tr('纸张', 'Paper') },
            { value: 'app', label: tr('跟随主题', 'Follow theme') },
          ],
          onChange: (value) => update({ theme: value }),
        }),
      ),
    ),
  )
}

/** The reader page body. */
function ReaderView({ state, actions, api }) {
  const current = state.current
  const settings = {
    ...RD_READER_DEFAULT_SETTINGS,
    ...(state.shelf && state.shelf.settings && typeof state.shelf.settings === 'object' ? state.shelf.settings : {}),
  }
  const toc = current && Array.isArray(current.toc) ? current.toc : []
  const rawChapterIndex = current ? Math.trunc(Number(current.chapterIndex) || 0) : 0
  const chapterIndex = toc.length > 0 ? clamp(rawChapterIndex, 0, toc.length - 1) : Math.max(0, rawChapterIndex)
  const bookChapterCount = current && current.book ? Math.max(0, Math.trunc(Number(current.book.chapterCount) || 0)) : 0
  const chapterCount = toc.length > 0 ? toc.length : bookChapterCount
  const bookPercent =
    state.progress && Number.isFinite(Number(state.progress.percent)) ? clamp(Number(state.progress.percent), 0, 1) : 0
  const tocOpen = Boolean(state.reading && state.reading.tocOpen)
  const loading = Boolean(state.loadingBook)
  const theme = settings.theme === 'paper' ? 'paper' : 'app'
  const chapterKey = current && current.chapter ? `${current.book.id}:${current.chapterIndex}` : ''

  const scrollRef = useRef(null)
  const readerRef = useRef(null)
  const restoredRef = useRef('')
  const pendingRatioRef = useRef(null)
  const rafRef = useRef(0)
  // Chat pane width in px; 0 means "use the CSS default".
  const [chatWidth, setChatWidth] = useState(0)

  /** Clamp the chat pane to [280px, 45% of the reader] so the book keeps room. */
  const clampChatWidth = useCallback((width) => {
    const node = readerRef.current
    const total = node && node.clientWidth ? node.clientWidth : 0
    const max = total > 0 ? Math.max(240, Math.floor(total * 0.45)) : 520
    const min = Math.min(280, max)
    return clamp(Math.round(width), min, max)
  }, [])

  /** Drag the divider left to widen the conversation, right to narrow it. */
  const startChatResize = useCallback(
    (event) => {
      if (event && typeof event.button === 'number' && event.button !== 0) return
      if (event && typeof event.preventDefault === 'function') event.preventDefault()
      const node = readerRef.current
      if (!node) return
      const wrapper = node.querySelector('.rd-reader-chatwrap')
      const startX = event.clientX
      const startWidth =
        chatWidth > 0
          ? chatWidth
          : wrapper && wrapper.getBoundingClientRect
            ? wrapper.getBoundingClientRect().width
            : Math.min(430, node.clientWidth * 0.34)
      const onMove = (moveEvent) => {
        setChatWidth(clampChatWidth(startWidth + (startX - moveEvent.clientX)))
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.classList.remove('rd-resizing')
      }
      document.body.classList.add('rd-resizing')
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [chatWidth, clampChatWidth],
  )

  /** Scroll the article column to a 0..1 ratio. */
  const scrollToRatio = useCallback((ratio) => {
    const node = scrollRef.current
    if (!node) return
    const max = Math.max(0, node.scrollHeight - node.clientHeight)
    node.scrollTop = clamp(Number(ratio) || 0, 0, 1) * max
  }, [])

  /** Jump to a chapter (and optional ratio); used by the TOC and bookmarks. */
  const jumpTo = useCallback(
    (targetIndex, ratio) => {
      if (!current) return
      const target = clamp(Math.trunc(Number(targetIndex) || 0), 0, Math.max(0, toc.length - 1))
      const targetRatio = clamp(Number(ratio) || 0, 0, 1)
      if (target === chapterIndex) {
        scrollToRatio(targetRatio)
        actions.reportScroll(targetRatio)
        return
      }
      // The store resets progress on loadChapter; stash the target ratio and let
      // the chapter-load effect apply it once the new content has rendered.
      pendingRatioRef.current = targetRatio
      void actions.loadChapter(target)
    },
    [actions, chapterIndex, current, scrollToRatio, toc.length],
  )

  /** Move one chapter forward/backward (fresh chapters start at the top). */
  const goChapter = useCallback(
    (delta) => {
      if (!current) return
      const next = clamp(chapterIndex + delta, 0, Math.max(0, chapterCount - 1))
      if (next === chapterIndex) return
      pendingRatioRef.current = null
      void actions.loadChapter(next)
    },
    [actions, chapterCount, chapterIndex, current],
  )

  // Restore reading position once per loaded chapter: saved progress on first open
  // (or a bookmark ratio), otherwise the top of the chapter.
  useEffect(() => {
    if (!chapterKey || !current || !current.chapter) return undefined
    if (restoredRef.current === chapterKey) return undefined
    restoredRef.current = chapterKey
    const pending = pendingRatioRef.current
    pendingRatioRef.current = null
    const saved =
      pending !== null && pending !== undefined
        ? pending
        : state.progress && state.progress.chapterIndex === current.chapterIndex
          ? clamp(Number(state.progress.scrollRatio) || 0, 0, 1)
          : 0
    const timer = setTimeout(() => scrollToRatio(saved), 0)
    return () => clearTimeout(timer)
    // `current`/`state.progress` are intentionally read from the render that
    // produced this chapter key; only the key decides when to restore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterKey, scrollToRatio])

  // rAF-throttled scroll reporting; the store deducts duplicate ratios itself.
  const onScroll = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      const node = scrollRef.current
      if (!node) return
      const max = node.scrollHeight - node.clientHeight
      actions.reportScroll(max > 0 ? node.scrollTop / max : 0)
    })
  }, [actions])

  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
    }
  }, [])

  // Keyboard: ←/→ change chapters unless the user is typing; Esc closes drawers.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.defaultPrevented) return
      const target = event.target
      const tag = target && typeof target.tagName === 'string' ? target.tagName.toUpperCase() : ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        goChapter(-1)
        return
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        goChapter(1)
        return
      }
      if (event.key === 'Escape') {
        if (state.reading && (state.reading.tocOpen || state.reading.settingsOpen)) {
          event.preventDefault()
          actions.setReadingPanel({ tocOpen: false, settingsOpen: false })
        }
        actions.clearSelection()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [actions, goChapter, state.reading])

  // Article typography is applied through inline CSS variables so the CSS file
  // stays token-based and the settings take effect immediately.
  const articleStyle = useMemo(
    () => ({
      maxWidth: `${clamp(Number(settings.contentWidth) || RD_READER_DEFAULT_SETTINGS.contentWidth, 420, 1200)}px`,
      fontSize: `${clamp(Number(settings.fontSize) || RD_READER_DEFAULT_SETTINGS.fontSize, 12, 40)}px`,
      lineHeight: String(clamp(Number(settings.lineHeight) || RD_READER_DEFAULT_SETTINGS.lineHeight, 1.2, 3)),
      fontFamily:
        RD_READER_FONT_STACKS[settings.fontFamily] || RD_READER_FONT_STACKS.serif,
    }),
    [settings.contentWidth, settings.fontFamily, settings.fontSize, settings.lineHeight],
  )

  if (!current) return null
  const book = current.book || {}
  const chapter = current.chapter && typeof current.chapter === 'object' ? current.chapter : null
  const chapterTitle =
    chapter && typeof chapter.title === 'string' ? chapter.title.trim() : ''
  const showChapterTitle = chapterTitle.length > 0 && rdReaderLeadHeadingText(chapter.blocks) !== chapterTitle
  const displayIndex = chapterIndex + 1
  const paper = theme === 'paper'

  return h(
    'div',
    { className: 'rd-reader', ref: readerRef },
    h(
      'div',
      { className: 'rd-reader-main' },
      h(
        'div',
        { className: 'rd-reader-scroll', ref: scrollRef, onScroll },
        h(
          'div',
          { className: 'rd-reader-stage' },
          h(
            'article',
            { className: cx('rd-reader-article', paper && 'is-paper'), style: articleStyle },
            chapter
              ? h(
                  'header',
                  { className: 'rd-reader-chapter-head' },
                  h('div', { className: 'rd-reader-chapter-index' }, tr(`第 ${displayIndex} 章`, `Chapter ${displayIndex}`)),
                  showChapterTitle ? h('h1', { className: 'rd-reader-chapter-title' }, chapterTitle) : null,
                )
              : null,
            chapter
              ? h(RD_READER_CHAPTER_MEMO, { blocks: chapter.blocks, api, bookId: book.id || '', toc, onJump: jumpTo })
              : h(ReaderSkeleton),
            chapter
              ? h(ChapterNav, {
                  currentIndex: chapterIndex,
                  chapterCount,
                  percent: bookPercent,
                  onPrev: () => goChapter(-1),
                  onNext: () => goChapter(1),
                  disabled: loading,
                })
              : null,
          ),
        ),
      ),
      h(RD_READER_TOC_MEMO, { current, open: tocOpen, actions, onJump: jumpTo }),
      loading ? h('div', { className: 'rd-reader-loadingbar', role: 'progressbar', 'aria-label': tr('正在加载章节', 'Loading chapter') }) : null,
      loading
        ? h('div', { className: 'rd-reader-loadingpill', role: 'status' }, h(Spinner, { size: 12 }), tr('正在加载…', 'Loading…'))
        : null,
    ),
    // Divider + always-visible conversation pane on the right (60-ask.js).
    // The divider drags left to widen the chat, capped at 45% of the reader.
    typeof ChatPane === 'function'
      ? [
          h('div', {
            key: 'split',
            className: 'rd-reader-split',
            role: 'separator',
            'aria-orientation': 'vertical',
            'aria-label': tr('调整对话区宽度', 'Resize the conversation pane'),
            tabIndex: 0,
            onPointerDown: startChatResize,
            onKeyDown: (event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault()
                const node = readerRef.current
                const base =
                  chatWidth > 0
                    ? chatWidth
                    : node
                      ? Math.min(430, node.clientWidth * 0.34)
                      : 380
                setChatWidth(clampChatWidth(base + (event.key === 'ArrowLeft' ? 24 : -24)))
              }
            },
          }),
          h(
            'div',
            {
              key: 'chat',
              className: 'rd-reader-chatwrap',
              style: chatWidth > 0 ? { width: `${chatWidth}px` } : undefined,
            },
            h(ChatPane, { state, actions }),
          ),
        ]
      : null,
    // Floating selection intent menu, owned by 60-ask.js.
    typeof SelectionToolbar === 'function' ? h(SelectionToolbar, { state, actions, containerRef: scrollRef }) : null,
    typeof NotesDrawer === 'function' ? h(NotesDrawer, { state, actions }) : null,
    h(ReaderSettingsDialog, { settings: state.shelf && state.shelf.settings, open: state.reading && state.reading.settingsOpen, actions }),
  )
}

addStyles(`
.rd-reader { flex: 1; min-width: 0; min-height: 0; display: flex; overflow: hidden; }
.rd-reader-main { position: relative; flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; overflow: hidden; }
.rd-reader-chatwrap {
  flex: none; min-width: 0; min-height: 0; display: flex;
  width: clamp(300px, 34vw, 430px);
}
.rd-reader-chatwrap > .rd-chat { flex: 1 1 auto; width: 100%; }
.rd-reader-split {
  flex: none; width: 7px; margin: 0 -3px; position: relative; z-index: 6;
  cursor: col-resize; touch-action: none; background: transparent;
}
.rd-reader-split::after {
  content: ''; position: absolute; top: 0; bottom: 0; left: 3px; width: 1px;
  background: var(--dsw-alias-border-l1); transition: background .12s ease;
}
.rd-reader-split:hover::after,
.rd-reader-split:focus-visible::after { background: var(--dsw-alias-brand-primary); }
body.rd-resizing { cursor: col-resize; user-select: none; }
@media (max-width: 900px) {
  .rd-reader { flex-direction: column; }
  .rd-reader-main { flex: 1 1 58%; }
  .rd-reader-split { display: none; }
  .rd-reader-chatwrap { width: auto !important; flex: 1 1 42%; }
  .rd-reader-chatwrap > .rd-chat { border-top: 1px solid var(--dsw-alias-border-l1); }
}
.rd-reader-scroll { flex: 1; min-width: 0; min-height: 0; overflow: auto; overscroll-behavior: contain; }
.rd-reader-stage { display: flex; justify-content: center; padding: 24px 24px 0; }
.rd-reader-article { width: 100%; min-width: 0; padding: 40px 32px 120px; border-radius: 0; }
.rd-reader-article.is-paper {
  background: var(--rd-paper);
  border: 1px solid var(--rd-paper-line);
  border-radius: var(--rd-radius-lg);
  box-shadow: 0 1px 3px rgba(0, 0, 0, .06);
  min-height: 62vh;
}
.rd-reader-chapter-head { margin: 0 0 1.8em; text-indent: 0; }
.rd-reader-chapter-index {
  margin-bottom: .55em; font-size: 12px; letter-spacing: .12em;
  color: var(--dsw-alias-label-secondary);
}
.rd-reader-chapter-title { margin: 0; font-size: 1.55em; line-height: 1.35; font-weight: 600; text-indent: 0; }
.rd-reader-blocks { text-indent: 0; }
.rd-reader-blocks > p { margin: 0 0 .85em; text-indent: 2em; }
.rd-reader-blocks > p:last-child { margin-bottom: 0; }
.rd-reader-blocks > h1,
.rd-reader-blocks > h2,
.rd-reader-blocks > h3,
.rd-reader-blocks > h4,
.rd-reader-blocks > h5,
.rd-reader-blocks > h6 {
  text-indent: 0; line-height: 1.4; font-weight: 600;
  margin: 1.7em 0 .7em;
}
.rd-reader-blocks > h1 { font-size: 1.4em; }
.rd-reader-blocks > h2 { font-size: 1.26em; }
.rd-reader-blocks > h3 { font-size: 1.14em; }
.rd-reader-blocks > h4 { font-size: 1.06em; }
.rd-reader-blocks > h5,
.rd-reader-blocks > h6 { font-size: 1em; }
.rd-reader-blocks > .rd-reader-empty { text-indent: 0; font-size: .9em; }
.rd-reader-quote {
  margin: 1.2em 0; padding: .1em 0 .1em 1em;
  border-left: 3px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
}
.rd-reader-quote p { text-indent: 0; margin: 0 0 .5em; }
.rd-reader-quote p:last-child { margin-bottom: 0; }
.rd-reader-list { margin: 0 0 .9em; padding-left: 1.7em; }
.rd-reader-list li { margin: .22em 0; text-indent: 0; }
.rd-reader-list li p { text-indent: 0; }
.rd-reader-hr { border: 0; height: 1px; background: var(--dsw-alias-border-l1); margin: 1.8em 0; }
.rd-reader-blank { height: .85em; }
.rd-reader-img {
  display: block; max-width: 100%; height: auto;
  margin: 1em auto; border-radius: var(--rd-radius-sm);
}
.rd-reader-code {
  font-family: var(--dsh-font-family-mono, ui-monospace, SFMono-Regular, monospace);
  font-size: .88em; white-space: pre-wrap;  background: color-mix(in oklab, var(--dsw-alias-bg-layer-2) 70%, transparent);
  border-radius: 4px; padding: .08em .32em;
}
.rd-reader-article a { color: var(--dsw-alias-brand-primary); text-decoration: underline; text-underline-offset: 2px; }
.rd-reader-link {
  display: inline; border: 0; background: none; padding: 0; margin: 0;
  font: inherit; color: var(--dsw-alias-brand-primary);
  text-decoration: underline; text-underline-offset: 2px; cursor: pointer; text-align: inherit;
}
.rd-reader-link:hover { color: color-mix(in oklab, var(--dsw-alias-brand-primary) 82%, var(--dsw-alias-label-primary)); }
.rd-reader-link.is-unresolved { color: inherit; text-decoration: none; cursor: default; }
.rd-reader-link.is-external { color: var(--dsw-alias-brand-primary); }
.rd-reader-article ruby rt { font-size: .5em; letter-spacing: 0; color: var(--dsw-alias-label-secondary); }
.rd-reader-article sup,
.rd-reader-article sub { font-size: .75em; line-height: 0; }
.rd-reader-article u { text-underline-offset: 2px; }
.rd-reader-run { text-indent: 0; }
.rd-reader-empty { color: var(--dsw-alias-label-secondary); text-indent: 0; font-size: .9em; }
.rd-reader-nav {
  display: flex; align-items: center; gap: 12px;
  margin-top: 2.6em; padding-top: 1.4em;
  border-top: 1px solid var(--dsw-alias-border-l1); text-indent: 0;
}
.rd-reader-nav-mid { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 7px; }
.rd-reader-nav-count { font-size: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.rd-reader-nav-progress { width: 100%; max-width: 240px; }

.rd-reader-toc {
  position: absolute; top: 0; bottom: 0; left: 0; z-index: 20;
  width: 260px; max-width: 86%;
  display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-layer-1);
  border-right: 1px solid var(--dsw-alias-border-l1);
  box-shadow: 8px 0 24px rgba(0, 0, 0, .1);
}
.rd-reader-toc-head {
  display: flex; align-items: flex-start; gap: 8px;
  flex: none; padding: 14px 12px 10px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.rd-reader-toc-book { flex: 1; min-width: 0; }
.rd-reader-toc-book-title {
  font-size: 13px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rd-reader-toc-book-sub { margin-top: 3px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.rd-reader-toc-list { flex: 1; min-height: 0; overflow: auto; padding: 6px; }
.rd-reader-toc-item {
  display: flex; align-items: flex-start; gap: 8px; width: 100%;
  padding: 7px 8px; border: 0; background: transparent; cursor: pointer;
  border-radius: var(--rd-radius-sm);
  color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 1.45; text-align: left;
}
.rd-reader-toc-item:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.rd-reader-toc-item.is-active {
  background: color-mix(in oklab, var(--dsw-alias-brand-primary) 12%, transparent);
  color: var(--dsw-alias-label-primary); font-weight: 600;
}
.rd-reader-toc-item:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.rd-reader-toc-num {
  flex: none; width: 20px; padding-top: 1px;
  font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums;
}
.rd-reader-toc-title {
  flex: 1; min-width: 0; word-break: break-word;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.rd-reader-toc-empty { padding: 8px; font-size: 11px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
.rd-reader-toc-bookmarks {
  flex: none; max-height: 40%; overflow: auto;
  padding: 6px 6px 10px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.rd-reader-toc-section {
  padding: 5px 8px; font-size: 11px; letter-spacing: .06em;
  color: var(--dsw-alias-label-secondary);
}
.rd-reader-bm-item { display: flex; align-items: flex-start; gap: 4px; padding: 5px 6px; border-radius: var(--rd-radius-sm); }
.rd-reader-bm-item:hover { background: var(--dsw-alias-bg-layer-2); }
.rd-reader-bm-jump {
  flex: 1; min-width: 0; border: 0; background: transparent; padding: 0;
  font: inherit; text-align: left; color: var(--dsw-alias-label-primary); cursor: pointer;
}
.rd-reader-bm-label {
  display: block; font-size: 12px; line-height: 1.4;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rd-reader-bm-meta {
  display: block; margin-top: 2px; font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rd-reader-bm-delete { flex: none; width: 22px; height: 22px; }

.rd-reader-loadingbar {
  position: absolute; top: 0; left: 0; right: 0; height: 2px;
  z-index: 30; overflow: hidden; pointer-events: none;
}
.rd-reader-loadingbar::after {
  content: ''; position: absolute; top: 0; bottom: 0; width: 34%;
  border-radius: 2px; background: var(--dsw-alias-brand-primary);
  animation: rd-reader-slide 1.15s ease-in-out infinite;
}
@keyframes rd-reader-slide { 0% { left: -36%; } 100% { left: 100%; } }
.rd-reader-loadingpill {
  position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
  z-index: 30; display: flex; align-items: center; gap: 7px;
  padding: 5px 10px; border-radius: 999px; pointer-events: none;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-secondary); font-size: 11px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, .1);
}
.rd-reader-skeleton { display: flex; flex-direction: column; gap: 13px; padding: 6px 0 48px; }
.rd-reader-skeleton-line {
  height: 12px; border-radius: 6px;
  background: color-mix(in oklab, var(--dsw-alias-label-secondary) 16%, transparent);
  animation: rd-reader-pulse 1.4s ease-in-out infinite;
}
@keyframes rd-reader-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }

.rd-reader-settings { display: flex; flex-direction: column; gap: 2px; }
.rd-reader-setting-group { display: flex; flex-direction: column; gap: 7px; margin: 8px 0 10px; }
.rd-reader-setting-group .rd-segmented { align-self: flex-start; }

@media (max-width: 760px) {
  .rd-reader-stage { padding: 12px 10px 0; }
  .rd-reader-article { padding: 26px 18px 88px; }
  .rd-reader-nav { gap: 8px; }
  .rd-reader-toc { width: 232px; }
}
`)
