# 阅读插件 · Client 开发契约

面向 `client-src/` 的并行开发者。所有 `client-src/*.js` 会被 `scripts/build-client.mjs`
按文件名排序**拼接进同一个 loader factory 闭包**，因此：

- 各文件共享闭包作用域（`React`、`h`、`Icon`、`Button`、`useReading()`、`READING_ACTIONS`、`translate` 等直接可用）。
- 组件必须用 **`function` 声明**（会被提升，跨文件互相引用安全），不要用 `const X = () => ...` 定义会被其它文件引用的组件。
- 不要 `import` / `export`；不要写 JSX。
- 需要新样式：在文件末尾调用 `addStyles(\`...\`)`，类名统一 `rd-` 前缀。
- 可见文案用 `tr('中文', 'English')`；短标签也可以用 `label('shelf.title')`。不要出现只有中文的硬编码英文场景。

## 构建与自检

```powershell
cd D:\Personal\dsh-plugins\dsh-plugin-reading
node scripts/build-client.mjs          # 生成 client.js
node --check client.js                 # 语法自检（必须通过）
```

构建后由 Lead 安装 bundle 并在 Web GUI 验证；你不需要（也不要）自己安装。

## 可用的共享设施（已实现）

### 状态与动作

```js
const state = useReading()          // 订阅整个 store
const actions = READING_ACTIONS     // 动作集合
const api = READING_API             // { coverUrl(bookId), assetUrl(bookId, name), rpc(...) }
```

`state` 关键字段：

```js
{
  status: 'loading' | 'ready' | 'error',
  error: string | null,
  view: 'shelf' | 'reader' | 'notes',
  shelf: { books: Book[], settings: Settings, notesCount: number, libraryDir: string },
  importing: boolean,
  current: null | {
    book: Book, toc: [{ index, title }], chapterIndex: number,
    chapter: { title, blocks: Block[] } | null,
    bookmarks: Bookmark[]
  },
  loadingBook: boolean,
  reading: { tocOpen, notesOpen, settingsOpen },
  progress: { chapterIndex, scrollRatio, percent },   // percent 0..1
  selection: null | { text, x, y, chapterIndex },
  ask: { open, streaming, question, quote, chapterIndex, answer, error, history: [{question,answer}] },
  notes: Note[],
  notesLoading: boolean,
  search: { open, q, loading, results: [{bookId,bookTitle,chapterIndex,chapterTitle,snippet}] },
  toast: { message, tone } | null
}

Book = { id, title, author, language, description, chapterCount, cover:boolean, coverType,
         bytes, addedAt, lastReadAt, openedCount,
         progress: { chapterIndex, scrollRatio, percent, updatedAt },
         bookmarks: Bookmark[] }
Bookmark = { id, chapterIndex, scrollRatio, quote, label, chapterTitle, createdAt }
Note = { id, bookId, bookTitle, chapterIndex, chapterTitle, quote, question, answer, note, tags, createdAt, updatedAt }
Settings = { fontSize, lineHeight, fontFamily: 'serif'|'sans'|'kai'|'song', theme: 'paper'|'app'|'dark-paper', contentWidth, lastBookId }
```

动作（全部返回 Promise 或 void，失败时已内部 toast，调用方一般 `void actions.x()` 即可）：

```js
actions.bootstrap()
actions.refreshShelf()
actions.importFile(File)
actions.openBook(bookId)                 // 进入 reader
actions.loadChapter(index)               // 切换章节
actions.reportScroll(ratio0to1)          // 阅读器滚动时调用（自己 rAF 节流）
actions.flushProgress()
actions.closeBook()                      // 回书架
actions.setView('shelf'|'notes')
actions.setReadingPanel({ tocOpen, notesOpen, settingsOpen })
actions.setSelection(sel | null); actions.clearSelection()
actions.setSettings(patch)               // 写回 Host
actions.toggleBookmark(); actions.removeBookmark(id)
actions.askQuestion(question, { quote?, chapterIndex? })
actions.cancelAsk(); actions.closeAsk(); actions.resetAsk()
actions.saveAskAsNote({ note?, tags? })  // 返回 note
actions.bringAskToConversation()         // 选段+问题 -> 新对话草稿
actions.loadNotes(query?); actions.saveNote(note); actions.deleteNote(id); actions.exportNotes(bookId?)
actions.search(q); actions.openSearch(); actions.closeSearch()
actions.toast(message, 'info'|'error'); actions.fail(error)
```

### 基础组件（10-ui.js）

`Icon({name,size})`（可用 name：book, back, toc, note, bookmark, settings, search, close, plus, trash,
download, send, sparkles, chevronLeft, chevronRight, chevronDown, more, check, edit, copy, quote,
arrowUp, arrowDown, bookOpen, chat, upload, refresh）、`Button({variant:'primary'|'secondary'|'ghost'|'danger',
size:'sm'|'md', icon, children, onClick, disabled})`、`IconButton({icon,label,onClick,active})`、
`Spinner`、`Empty({icon,title,description,action})`、`Dialog({open,onClose,title,description,children,footer,width})`、
`TextField({label,value,onChange,placeholder,multiline,rows,onKeyDown,hint})`、
`Segmented({value,options:[{value,label}],onChange})`、`Slider({label,value,min,max,step,suffix,onChange})`、
`Notice({tone:'info'|'error'|'warn',children,action})`、`Toast({toast,onDismiss})`、
`Progress({value})`、`MarkdownText({text})`、`StyleSheet`、`cx(...)`、`clamp`、`debounce`、`formatDate`。

### 样式

只用 host 主题 token，禁止写死颜色（除语义化纸张底色可用 `color-mix`）：

- 背景：`--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1`、`--dsw-alias-bg-layer-2`、`--dsw-alias-bg-overlay`
- 文本：`--dsw-alias-label-primary`、`--dsw-alias-label-secondary`
- 边框：`--dsw-alias-border-l1`、`--dsw-alias-border-l2`
- 强调：`--dsw-alias-brand-primary`；状态：`--dsw-alias-state-error-primary` / `warn` / `success`
- 纸张可由 10-ui 的 `--rd-paper` / `--rd-paper-line` 取用；圆角变量 `--rd-radius-sm/md/lg`
- 顶部已由 `.rd-header` 预留 `--dsh-frame-top-clearance`

主面板根节点 `.rd-root` 是 `position:absolute; inset:0` 的 flex 列；页面内容自行滚动
（`.rd-scroll`）。不要使用 `position:fixed` 做页面内布局（抽屉/工具栏用 absolute 相对 `.rd-root`）。

## 文件分工

### `40-shelf.js` — 书架
导出 `function ShelfView({ state, actions, api })`

- 书卡网格：封面（`api.coverUrl(id)`，无封面用书名 + 装饰底色），书名、作者、章节数、
  `Progress` 阅读进度、上次阅读时间；点击 `actions.openBook(id)`。
- 卡片悬浮操作：删除（二次确认 `Dialog`）、继续阅读。
- 顶部工具行：搜索正文（点击 `actions.openSearch()`）、排序（最近阅读/导入时间/书名）、
  空状态用 `Empty` + 导入按钮（`actions.setView('shelf')` 后由面板头部导入，或直接提供按钮
  调用隐藏 input 不存在时用 `actions.toast` 提示拖拽导入）。
- 导入中显示 `state.importing` 状态与进度提示。
- 拖拽导入由面板根处理，书架只需展示。

### `50-reader.js` — 阅读器
导出 `function ReaderView({ state, actions, api })`，内部至少：

- `ChapterContent`：把 `current.chapter.blocks` 渲染成 React：
  - `h` → h1..h6；`p` → `<p>`；`quote` → `<blockquote>`；`list` → ul/ol；`hr`；`blank` → 间距；
  - `img` → `<img src={api.assetUrl(book.id, block.src)} loading="lazy">`；
  - inline run：`{text, b,i,u,sup,sub,ruby,href,code}` → `<strong>/<em>/<u>/<sup>/<sub>/<ruby>base<rt>ruby</rt></ruby>/<a>/<code>`。
  - 章节标题在正文顶部再显示一次（`current.chapter.title`）。
- 滚动进度：滚动容器 `onScroll` 用 rAF 节流计算 `scrollTop/(scrollHeight-clientHeight)` 并
  `actions.reportScroll(ratio)`；章节切换后滚动到顶部（或读取 `progress.scrollRatio` 恢复，若
  进入的是上次章节）。
- 目录：左侧抽屉（`state.reading.tocOpen`），列出 `current.toc`，当前章高亮，点击
  `actions.loadChapter(index)`；底部显示书签列表（`BookmarkList`，点击跳到 `bookmark.chapterIndex`
  并恢复 `scrollRatio`，可删除）。
- 阅读设置：`state.reading.settingsOpen` 时打开 `Dialog`，含字号/行距/内容宽度 `Slider`、
  字体 `Segmented`（宋/黑/楷）、主题 `Segmented`（纸张/跟随主题），改动立即
  `actions.setSettings(patch)`。正文样式通过内联 style 变量应用。
- 底部/顶部章节导航：上一章/下一章按钮 + `第 N/M 章`。
- 组合 `h(SelectionToolbar, {state, actions, containerRef})`、`h(AskDrawer, {state, actions})`、
  `h(NotesDrawer, {state, actions})`（后两者由其它文件提供，函数声明会提升，直接引用即可）。

### `60-ask.js` — 选段与问答
导出 `function SelectionToolbar({ state, actions, containerRef })`、`function AskDrawer({ state, actions })`

- `SelectionToolbar`：在正文容器上监听 `mouseup`/`contextmenu`：
  - 有非空选区 → 读取 `window.getSelection().toString()`，用 `Range.getBoundingClientRect()` 定位
    （相对 `.rd-root`），`actions.setSelection({text, x, y, chapterIndex: current.chapterIndex})`；
    右键时同样触发，并 `preventDefault()` 阻止浏览器默认菜单。
  - 无选区/点击别处/Esc → `actions.clearSelection()`。
  - 浮动工具条样式：绝对定位、`--dsw-alias-bg-overlay` 背景、阴影、圆角；按钮：
    「问 AI」（`actions.askQuestion('', {quote, chapterIndex})` 打开抽屉并聚焦输入）、
    「记笔记」（`actions.saveNote({quote, ...})` 前先弹轻量 `Dialog` 让用户写补充，或直接存草稿）、
    「复制」。
- `AskDrawer`：`state.ask.open` 时右侧抽屉（宽度约 380px，`position:absolute` 于 `.rd-root`）：
  - 顶部显示选中原文（截断，可展开）、关闭按钮；
  - 问题输入框（`TextField` multiline，`Ctrl/Cmd+Enter` 提交）、快捷问题 chips
    （解释这段 / 字词训诂 / 典故出处 / 翻译成现代汉语）；
  - 回答区流式渲染 `MarkdownText`，`streaming` 时显示 `Spinner` + 停止按钮（`actions.cancelAsk`）；
  - 底部动作：「存为笔记」(`actions.saveAskAsNote()`)、「带入对话」(`actions.bringAskToConversation()`)、
    「复制回答」；
  - 无问答时展示引导文案；错误用 `Notice`。
  - 抽屉内保留 `state.ask.history` 供用户回看（可折叠）。

### `70-notes.js` — 笔记与搜索
导出 `function NotesView({ state, actions })`、`function NotesDrawer({ state, actions })`、
`function SearchOverlay({ state, actions })`

- `NotesView`：笔记页。左侧筛选（全部/当前书/关键词），列表按书分组或平铺；每条显示书名+章节、
  原文引用（`quote`）、问题、回答（`MarkdownText`）、补记；操作：编辑（`Dialog` 中编辑 note/answer、
  标签）、删除（确认）、跳转原文（`actions.openBook(bookId)` 后 `actions.loadChapter(chapterIndex)`）、
  导出（`actions.exportNotes(bookId)`）。
- `NotesDrawer`：阅读器右侧抽屉（`state.reading.notesOpen`），只显示当前书笔记，可新建空白笔记、
  跳转、删除。
- `SearchOverlay`：`state.search.open` 时覆盖层：搜索框（自动聚焦、输入防抖 300ms `actions.search`）、
  结果列表（书名/章节/片段，点选 → `actions.closeSearch()` + `openBook` + `loadChapter`）、
  loading/空状态、关闭。

## 质量要求

- 空状态、加载状态、错误状态都要有；不要出现 `undefined` 文本。
- 所有请求走 `actions`，不要在视图里直接 `fetch`。
- 组件不要有外部副作用（除 `useEffect` 内注册监听并在 cleanup 中移除）。
- 中文为主、英文兜底；文案用 `tr(zh, en)`。
- 键盘可达：按钮用 `<button>`，对话框 Esc 关闭；工具条可用 Tab 聚焦。
- 完成后运行 `node scripts/build-client.mjs && node --check client.js`，把输出贴回来。
