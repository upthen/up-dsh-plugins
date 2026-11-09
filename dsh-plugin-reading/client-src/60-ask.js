/**
 * Reader conversation surfaces.
 *
 * `SelectionToolbar` floats an intent menu above a text selection (解释 / 训诂 /
 * 典故 / 翻译 / 自己提问 / 复制 / 记笔记). `ChatPane` is the always-visible
 * right-hand conversation: one persistent message list per book, streaming answers,
 * per-answer note/hand-off actions and a composer.
 *
 * Both are rendered by 50-reader inside `.rd-root`: the toolbar is absolutely
 * positioned against the reading root, the chat pane is a flex column of the reader
 * split. The note editor is the shared `NoteEditorDialog` declared in 70-notes
 * (function declarations hoist in the concatenated client factory).
 */

/** Copy one string through the async Clipboard API, with a hidden-textarea fallback. */
async function copyTextSafe(text) {
  const value = String(text == null ? '' : text)
  if (!value) return false
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // The async API is missing or denied; fall through to the legacy path.
  }
  try {
    const area = document.createElement('textarea')
    area.value = value
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-9999px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = typeof document.execCommand === 'function' && document.execCommand('copy')
    area.remove()
    return copied === true
  } catch {
    return false
  }
}

/** Split a free-form tag input into a small unique list (used by the shared note dialog). */
function parseTagInput(text) {
  const tags = []
  String(text == null ? '' : text)
    .split(/[,，、;；\s]+/)
    .forEach((raw) => {
      const tag = raw.trim().replace(/^#+/, '')
      if (tag && tags.indexOf(tag) < 0) tags.push(tag)
    })
  return tags.slice(0, 8)
}

/** Trim one-line preview text, adding an ellipsis when it was cut. */
function askTruncate(text, max) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}

/**
 * Read the current DOM selection when it lives inside the reader column.
 * Returns `{ text, x, y }` where x/y are the selection rect's top-center in the
 * reading root's coordinate space, already clamped into the visible area.
 */
function readSelectionAnchor(container) {
  if (!container || typeof window === 'undefined') return null
  const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
  if (!selection || selection.rangeCount < 1) return null
  const text = String(selection.toString() || '').trim()
  if (!text) return null
  const anchorNode = selection.anchorNode
  const focusNode = selection.focusNode
  if (!anchorNode || !focusNode) return null
  if (!container.contains(anchorNode) || !container.contains(focusNode)) return null
  let range
  try {
    range = selection.getRangeAt(0)
  } catch {
    return null
  }
  const rect = range.getBoundingClientRect()
  if (!rect || (!rect.width && !rect.height)) return null
  const root = container.closest('.rd-root') || container
  const rootRect = root.getBoundingClientRect()
  const viewportWidth = window.innerWidth || rootRect.width || 0
  const viewportHeight = window.innerHeight || rootRect.height || 0
  const centerX = clamp(rect.left + rect.width / 2, 16, Math.max(16, viewportWidth - 16))
  const topY = clamp(rect.top, 56, Math.max(56, viewportHeight - 16))
  return {
    text,
    x: clamp(centerX - rootRect.left, 8, Math.max(8, rootRect.width - 8)),
    y: clamp(topY - rootRect.top, 40, Math.max(40, rootRect.height - 8)),
  }
}

/** Selection intents: the label plus the question sent with the quoted passage. */
const RD_ASK_INTENTS = [
  {
    key: 'explain',
    label: () => tr('解释这段', 'Explain'),
    icon: 'sparkles',
    question: () =>
      tr(
        '请解释这段原文的意思，并结合上下文说明它在全章中的作用。',
        'Explain this passage and its role in the surrounding context.',
      ),
  },
  {
    key: 'gloss',
    label: () => tr('字词训诂', 'Word gloss'),
    icon: 'quote',
    question: () =>
      tr(
        '请对这段文字中的关键字词做训诂：读音、义项、出处，必要时比较不同注解。',
        'Gloss the key words in this passage: readings, senses, sources, and differences between commentaries.',
      ),
  },
  {
    key: 'allusion',
    label: () => tr('典故出处', 'Allusions'),
    icon: 'book',
    question: () =>
      tr('这段文字涉及哪些典故或前人成句？请给出出处与相关原文。', 'Which allusions or earlier texts appear here? Give sources and the original lines.'),
  },
  {
    key: 'modern',
    label: () => tr('译成现代汉语', 'Translate'),
    icon: 'chat',
    question: () =>
      tr('请把这段原文译成现代汉语，尽量保留原意与语气。', 'Translate this passage into modern Chinese, keeping its meaning and tone.'),
  },
]

/**
 * Floating intent menu above the current selection.
 * Renders nothing while `state.selection` is null.
 */
function SelectionToolbar({ state, actions, containerRef }) {
  const [noteDraft, setNoteDraft] = useState(null)
  // The latest committed selection, used by the context-menu path when the
  // browser has already collapsed the DOM selection.
  const selectionRef = useRef(state.selection)
  selectionRef.current = state.selection

  useEffect(() => {
    const container = containerRef && containerRef.current ? containerRef.current : null
    if (!container) return undefined
    let timer = 0
    const commitSelection = () => {
      const anchor = readSelectionAnchor(container)
      if (!anchor) {
        actions.clearSelection()
        return
      }
      const current = state.current
      actions.setSelection({
        text: anchor.text,
        x: anchor.x,
        y: anchor.y,
        chapterIndex: current && Number.isInteger(current.chapterIndex) ? current.chapterIndex : 0,
      })
    }
    const scheduleCommit = () => {
      clearTimeout(timer)
      timer = window.setTimeout(commitSelection, 0)
    }
    const onMouseUp = () => scheduleCommit()
    /**
     * Right-click on a selection is the quick gesture: ask the default
     * "explain this passage" question straight into the right-hand chat instead
     * of opening the intent menu. The menu stays on the left-button selection.
     */
    const onContextMenu = (event) => {
      const anchor = readSelectionAnchor(container)
      const committed = selectionRef.current
      const text = anchor ? anchor.text : committed && typeof committed.text === 'string' ? committed.text : ''
      if (!text) return
      event.preventDefault()
      const current = state.current
      const chapterIndex =
        anchor && current && Number.isInteger(current.chapterIndex)
          ? current.chapterIndex
          : committed && Number.isInteger(committed.chapterIndex)
            ? committed.chapterIndex
            : current && Number.isInteger(current.chapterIndex)
              ? current.chapterIndex
              : 0
      actions.clearSelection()
      window.getSelection && window.getSelection() && window.getSelection().removeAllRanges()
      actions.askWithQuote(RD_ASK_INTENTS[0].question(), { quote: text, chapterIndex })
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') actions.clearSelection()
    }
    const onPointerDown = (event) => {
      // Ignore the non-primary buttons: the right-button pointerdown belongs to
      // the context-menu gesture, so clearing the selection here would make
      // right-click look dead.
      if (event && typeof event.button === 'number' && event.button !== 0) return
      const toolbar = container.closest('.rd-root')
      if (toolbar && event && event.target && toolbar.contains(event.target) && event.target.closest('.rd-ask-toolbar')) return
      actions.clearSelection()
    }
    container.addEventListener('mouseup', onMouseUp)
    container.addEventListener('contextmenu', onContextMenu)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.clearTimeout(timer)
      container.removeEventListener('mouseup', onMouseUp)
      container.removeEventListener('contextmenu', onContextMenu)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [actions, containerRef, state.current])

  const selection = state.selection
  if (!selection) return null

  const askIntent = (intent) => {
    actions.askWithQuote(intent.question(), { quote: selection.text, chapterIndex: selection.chapterIndex })
    actions.clearSelection()
  }

  const openNoteDialog = () => {
    const current = state.current
    if (!current || !current.book) return
    const index = Number.isInteger(selection.chapterIndex) ? selection.chapterIndex : 0
    const tocEntry = current.toc && current.toc[index] ? current.toc[index] : null
    setNoteDraft({
      quote: selection.text,
      chapterIndex: index,
      chapterTitle: (tocEntry && tocEntry.title) || (current.chapter && current.chapter.title) || '',
      bookId: current.book.id,
      bookTitle: current.book.title || '',
    })
    actions.clearSelection()
  }

  const copySelection = async () => {
    const copied = await copyTextSafe(selection.text)
    actions.toast(copied ? tr('已复制', 'Copied') : tr('复制失败，请手动复制', 'Copy failed'), copied ? 'info' : 'error')
    actions.clearSelection()
  }

  const saveNoteFromSelection = async (patch) => {
    if (!noteDraft) return false
    const saved = await actions.saveNote({
      bookId: noteDraft.bookId,
      bookTitle: noteDraft.bookTitle,
      chapterIndex: noteDraft.chapterIndex,
      chapterTitle: noteDraft.chapterTitle,
      quote: noteDraft.quote,
      question: '',
      answer: '',
      note: patch.note,
      tags: patch.tags,
    })
    if (!saved) return false
    actions.toast(tr('已记入笔记', 'Saved to notes'))
    return true
  }

  return h(
    'div',
    null,
    h(
      'div',
      {
        className: 'rd-ask-toolbar',
        role: 'toolbar',
        'aria-label': tr('选中文本操作', 'Selection actions'),
        style: { left: `${selection.x}px`, top: `${selection.y}px` },
      },
      RD_ASK_INTENTS.map((intent) =>
        h(
          'button',
          {
            key: intent.key,
            type: 'button',
            className: 'rd-ask-tool-btn',
            title: intent.label(),
            onClick: () => askIntent(intent),
          },
          h(Icon, { name: intent.icon, size: 13 }),
          h('span', null, intent.label()),
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'rd-ask-tool-btn',
          title: tr('把选段放进右侧输入框，自己写问题', 'Park the passage in the composer and ask your own question'),
          onClick: () => {
            actions.beginQuestion(selection.text, selection.chapterIndex)
            actions.clearSelection()
          },
        },
        h(Icon, { name: 'edit', size: 13 }),
        h('span', null, tr('自己提问', 'Ask myself')),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'rd-ask-tool-btn is-icon',
          title: tr('记笔记', 'Note'),
          'aria-label': tr('记笔记', 'Note'),
          onClick: openNoteDialog,
        },
        h(Icon, { name: 'note', size: 13 }),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'rd-ask-tool-btn is-icon',
          title: tr('复制', 'Copy'),
          'aria-label': tr('复制', 'Copy'),
          onClick: copySelection,
        },
        h(Icon, { name: 'copy', size: 13 }),
      ),
    ),
    noteDraft
      ? h(NoteEditorDialog, {
          open: true,
          draft: noteDraft,
          title: tr('记笔记', 'New note'),
          onClose: () => setNoteDraft(null),
          onSave: saveNoteFromSelection,
        })
      : null,
  )
}

/** One user turn: the quoted passage and the question inside one bubble. */
function ChatUserMessage({ message }) {
  return h(
    'div',
    { className: 'rd-chat-msg is-user' },
    h(
      'div',
      { className: 'rd-chat-bubble' },
      message.quote
        ? h('div', { className: 'rd-chat-quote', title: message.quote }, askTruncate(message.quote, 220))
        : null,
      message.text ? h('div', { className: 'rd-chat-question' }, message.text) : null,
    ),
  )
}

/** Collapsible "思考过程" block mirroring the main conversation's reasoning view. */
function ChatReasoning({ message }) {
  const streaming = Boolean(message.streaming)
  const [open, setOpen] = useState(streaming)
  useEffect(() => {
    setOpen(Boolean(message.streaming))
  }, [message.streaming])
  if (!message.reasoning) return null
  const chars = String(message.reasoning).length
  return h(
    'div',
    { className: cx('rd-chat-reasoning', streaming && 'is-live') },
    h(
      'button',
      {
        type: 'button',
        className: 'rd-chat-reasoning-toggle',
        'aria-expanded': open ? 'true' : 'false',
        onClick: () => setOpen((value) => !value),
      },
      h(Icon, { name: open ? 'chevronDown' : 'chevronRight', size: 12 }),
      h('span', null, streaming ? tr('正在思考…', 'Thinking…') : tr('思考过程', 'Reasoning')),
      h('span', { className: 'rd-chat-reasoning-meta' }, tr(`${chars} 字`, `${chars} chars`)),
    ),
    open
      ? h('div', { className: 'rd-chat-reasoning-body' }, String(message.reasoning))
      : null,
  )
}

/** One assistant turn: reasoning, streamed markdown, error/retry, per-answer actions. */
function ChatAssistantMessage({ message, state, actions }) {
  const streaming = Boolean(message.streaming)
  const done = !streaming && !message.error && Boolean(String(message.text || '').trim())
  return h(
    'div',
    { className: cx('rd-chat-msg', 'is-assistant', streaming && 'is-streaming') },
    message.error
      ? h(
          'div',
          { className: 'rd-chat-error' },
          h(Notice, {
            tone: 'error',
            action: h(
              Button,
              { size: 'sm', variant: 'secondary', icon: 'refresh', onClick: () => void actions.retryAsk(message.id) },
              tr('重试', 'Retry'),
            ),
          }, message.error),
        )
      : null,
    h(ChatReasoning, { message }),
    !message.error && message.text
      ? h(MarkdownText, { text: message.text, className: 'rd-chat-answer' })
      : null,
    streaming && !message.text && !message.reasoning
      ? h('div', { className: 'rd-chat-thinking' }, h(Spinner, { size: 12 }), tr('正在思考…', 'Thinking…'))
      : null,
    streaming && message.text ? h('span', { className: 'rd-chat-caret', 'aria-hidden': true }) : null,
    message.model && message.model.model
      ? h('div', { className: 'rd-chat-model-tag', title: tr('本条回答使用的模型', 'Model used for this answer') }, `${message.model.provider ? `${message.model.provider} · ` : ''}${message.model.model}`)
      : null,
    done
      ? h(
          'div',
          { className: 'rd-chat-actions' },
          h(
            Button,
            { size: 'sm', variant: 'ghost', icon: 'note', onClick: () => void actions.saveMessageNote(message.id) },
            tr('存为笔记', 'Save note'),
          ),
          h(
            Button,
            {
              size: 'sm',
              variant: 'ghost',
              icon: 'chat',
              onClick: () => void actions.bringMessageToConversation(message.id),
            },
            tr('带入对话', 'Continue in chat'),
          ),
          h(
            Button,
            {
              size: 'sm',
              variant: 'ghost',
              icon: 'copy',
              onClick: async () => {
                const copied = await copyTextSafe(message.text)
                actions.toast(copied ? tr('已复制', 'Copied') : tr('复制失败', 'Copy failed'), copied ? 'info' : 'error')
              },
            },
            tr('复制', 'Copy'),
          ),
        )
      : null,
  )
}

/** Model name helper for the picker label. */
function chatModelLabel(model) {
  if (!model || typeof model !== 'object') return ''
  const provider = typeof model.provider === 'string' ? model.provider : ''
  const name = typeof model.model === 'string' ? model.model : ''
  if (!name) return ''
  return provider ? `${provider} · ${name}` : name
}

/**
 * Composer model picker: follows the default model or pins one provider/model for
 * this reading conversation, matching the main conversation's model switch.
 */
function ChatModelPicker({ state, actions }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)
  const ask = state.ask || {}
  const models = ask.models || null
  const selection = ask.selection || null
  const defaultModel = models && models.default ? models.default : null

  useEffect(() => {
    if (!models && !ask.modelsLoading) void actions.loadAskModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event) => {
      const node = containerRef.current
      if (node && event.target instanceof Node && node.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const label = selection ? chatModelLabel(selection) : defaultModel ? tr(`默认 · ${chatModelLabel(defaultModel)}`, `Default · ${chatModelLabel(defaultModel)}`) : tr('默认模型', 'Default model')

  const choose = (next) => {
    actions.setAskModel(next)
    setOpen(false)
  }

  const providers = models && Array.isArray(models.providers) ? models.providers : []
  const selectionInDirectory = Boolean(
    selection &&
      providers.some(
        (provider) => provider.id === selection.provider && (provider.models || []).some((model) => model.id === selection.model),
      ),
  )
  const selectionMissing = Boolean(selection && !selectionInDirectory)

  return h(
    'div',
    { className: 'rd-chat-model', ref: containerRef },
    h(
      'button',
      {
        type: 'button',
        className: 'rd-chat-model-btn',
        title: selection ? `${selection.provider} / ${selection.model}` : tr('切换模型', 'Switch model'),
        'aria-haspopup': 'listbox',
        'aria-expanded': open ? 'true' : 'false',
        onClick: () => setOpen((value) => !value),
      },
      h(Icon, { name: 'sparkles', size: 12 }),
      h('span', { className: 'rd-chat-model-label' }, label || tr('默认模型', 'Default model')),
      h(Icon, { name: 'chevronDown', size: 12 }),
    ),
    open
      ? h(
          'div',
          { className: 'rd-chat-model-menu', role: 'listbox', 'aria-label': tr('选择模型', 'Choose a model') },
          h(
            'button',
            {
              type: 'button',
              role: 'option',
              'aria-selected': selection ? 'false' : 'true',
              className: cx('rd-chat-model-item', !selection && 'is-active'),
              onClick: () => choose(null),
            },
            h('span', { className: 'rd-chat-model-item-name' }, tr('跟随默认模型', 'Follow default model')),
            defaultModel ? h('span', { className: 'rd-chat-model-item-sub' }, chatModelLabel(defaultModel)) : null,
          ),
          selectionMissing
            ? h(
                'div',
                { className: 'rd-chat-model-group' },
                h('div', { className: 'rd-chat-model-group-title' }, tr('当前选择（不在目录中）', 'Current (not in directory)')),
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'option',
                    'aria-selected': 'true',
                    className: 'rd-chat-model-item is-active',
                    title: `${selection.provider} / ${selection.model}`,
                    onClick: () => choose(selection),
                  },
                  h(
                    'span',
                    { className: 'rd-chat-model-item-name' },
                    `${selection.provider} · ${selection.model}`,
                  ),
                  h(Icon, { name: 'check', size: 12 }),
                ),
              )
            : null,
          ask.modelsLoading
            ? h('div', { className: 'rd-chat-model-status' }, h(Spinner, { size: 11 }), tr('正在获取模型列表…', 'Loading models…'))
            : null,
          ask.modelsError
            ? h('div', { className: 'rd-chat-model-status is-error' }, ask.modelsError)
            : null,
          providers.map((provider) =>
            h(
              'div',
              { className: 'rd-chat-model-group', key: provider.id },
              h('div', { className: 'rd-chat-model-group-title' }, provider.name || provider.id),
              (provider.models || []).map((model) =>
                h(
                  'button',
                  {
                    key: model.id,
                    type: 'button',
                    role: 'option',
                    'aria-selected':
                      selection && selection.provider === provider.id && selection.model === model.id ? 'true' : 'false',
                    className: cx(
                      'rd-chat-model-item',
                      selection && selection.provider === provider.id && selection.model === model.id && 'is-active',
                    ),
                    title: `${provider.id} / ${model.id}${model.description ? `\n${model.description}` : ''}`,
                    onClick: () => choose({ provider: provider.id, model: model.id }),
                  },
                  h('span', { className: 'rd-chat-model-item-name' }, model.name || model.id),
                  selection && selection.provider === provider.id && selection.model === model.id
                    ? h(Icon, { name: 'check', size: 12 })
                    : model.description
                      ? h('span', { className: 'rd-chat-model-item-sub' }, model.description)
                      : null,
                ),
              ),
              provider.error ? h('div', { className: 'rd-chat-model-status is-error' }, provider.error) : null,
            ),
          ),
        )
      : null,
  )
}

/** The always-visible right conversation pane. */
function ChatPane({ state, actions }) {
  const ask = state.ask && typeof state.ask === 'object' ? state.ask : {}
  const messages = Array.isArray(ask.messages) ? ask.messages : []
  const streaming = Boolean(ask.streaming)
  const draftQuote = ask.draftQuote && typeof ask.draftQuote === 'object' ? ask.draftQuote : null
  const [text, setText] = useState('')
  const listRef = useRef(null)
  const inputRef = useRef(null)
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null
  const lastTextLength = lastMessage && typeof lastMessage.text === 'string' ? lastMessage.text.length : 0

  // Keep the transcript pinned to the newest turn while the answer streams in.
  useEffect(() => {
    const node = listRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [messages.length, lastTextLength, streaming, draftQuote])

  // "自己提问" parks a quote: focus the composer so the user can write right away.
  useEffect(() => {
    if (!draftQuote) return
    const node = inputRef.current
    if (node && typeof node.focus === 'function') node.focus()
  }, [draftQuote])

  // Grow the composer with its content up to a cap, like the main composer.
  useEffect(() => {
    const node = inputRef.current
    if (!node || typeof node.style === 'undefined') return
    node.style.height = 'auto'
    node.style.height = `${Math.min(180, Math.max(28, node.scrollHeight || 28))}px`
  }, [text])

  const send = () => {
    const value = String(text || '').trim()
    if (!value || streaming) return
    const options = draftQuote
      ? { quote: draftQuote.text, chapterIndex: draftQuote.chapterIndex }
      : {}
    void actions.askWithQuote(value, options)
    setText('')
  }

  const canSend = String(text || '').trim().length > 0 && !streaming

  return h(
    'section',
    { className: 'rd-chat', 'aria-label': tr('阅读对话', 'Reading conversation') },
    h(
      'div',
      { className: 'rd-chat-head' },
      h('span', { className: 'rd-chat-head-icon' }, h(Icon, { name: 'sparkles', size: 14 })),
      h('div', { className: 'rd-chat-head-title' }, tr('阅读对话', 'Reading chat')),
      h('div', { className: 'rd-chat-head-spacer' }),
      messages.length > 0
        ? h(IconButton, {
            icon: 'trash',
            label: tr('清空本本书的对话', 'Clear this book’s conversation'),
            onClick: () => actions.clearChat(),
          })
        : null,
    ),
    h(
      'div',
      { className: 'rd-chat-list', ref: listRef, role: 'log', 'aria-live': 'polite' },
      messages.length === 0
        ? h(
            'div',
            { className: 'rd-chat-empty' },
            h('div', { className: 'rd-chat-empty-icon' }, h(Icon, { name: 'sparkles', size: 22 })),
            h('div', { className: 'rd-chat-empty-title' }, tr('选中正文，开始提问', 'Select text to start asking')),
            h(
              'div',
              { className: 'rd-chat-empty-desc' },
              tr(
                '在左侧选中一段话，会出现「解释这段 / 字词训诂 / 典故出处 / 译成现代汉语」，回答会出现在这里；也可以直接在下面输入问题。',
                'Select a passage on the left to get explanations, glosses, allusions and translations here; you can also just type a question below.',
              ),
            ),
          )
        : messages.map((message) =>
            message.role === 'user'
              ? h(ChatUserMessage, { key: message.id, message })
              : h(ChatAssistantMessage, { key: message.id, message, state, actions }),
          ),
    ),
    h(
      'div',
      { className: 'rd-chat-composer' },
      draftQuote
        ? h(
            'div',
            { className: 'rd-chat-draft' },
            h('div', { className: 'rd-chat-draft-quote', title: draftQuote.text }, askTruncate(draftQuote.text, 160)),
            h(IconButton, {
              icon: 'close',
              label: tr('移除选段', 'Remove passage'),
              onClick: () => actions.clearDraftQuote(),
            }),
          )
        : null,
      h('textarea', {
        className: 'rd-chat-input',
        ref: inputRef,
        rows: 1,
        value: text,
        placeholder: tr(
          '给阅读助手发送消息…（Enter 发送，Shift+Enter 换行）',
          'Message the reading assistant… (Enter to send, Shift+Enter for a new line)',
        ),
        onChange: (event) => setText(event.target.value),
        onKeyDown: (event) => {
          const composing = event.isComposing || (event.nativeEvent && event.nativeEvent.isComposing)
          if (event.key === 'Enter' && !event.shiftKey && !composing) {
            event.preventDefault()
            send()
          }
        },
      }),
      h(
        'div',
        { className: 'rd-chat-composer-row' },
        h(ChatModelPicker, { state, actions }),
        h('div', { className: 'rd-chat-composer-spacer' }),
        streaming
          ? h(
              'button',
              {
                type: 'button',
                className: 'rd-chat-send is-stop',
                title: tr('停止生成', 'Stop generating'),
                'aria-label': tr('停止生成', 'Stop generating'),
                onClick: () => actions.cancelAsk(),
              },
              h('span', { className: 'rd-chat-stop-square', 'aria-hidden': true }),
            )
          : h(
              'button',
              {
                type: 'button',
                className: 'rd-chat-send',
                title: tr('发送消息', 'Send message'),
                'aria-label': tr('发送消息', 'Send message'),
                disabled: !canSend,
                onClick: send,
              },
              h(Icon, { name: 'arrowUp', size: 16 }),
            ),
      ),
    ),
  )
}

addStyles(`
.rd-ask-toolbar {
  position: absolute; z-index: 50; transform: translate(-50%, calc(-100% - 8px));
  display: flex; align-items: center; gap: 2px; flex-wrap: wrap;
  max-width: min(560px, calc(100% - 24px));
  padding: 4px; border-radius: var(--rd-radius-md);
  background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l1);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .18);
}
.rd-ask-tool-btn {
  display: inline-flex; align-items: center; gap: 4px;
  border: 0; background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; line-height: 1; padding: 6px 8px; border-radius: var(--rd-radius-sm);
  cursor: pointer; white-space: nowrap;
}
.rd-ask-tool-btn:hover { background: color-mix(in oklab, var(--dsw-alias-bg-layer-1) 70%, var(--dsw-alias-label-primary)); }
.rd-ask-tool-btn.is-icon { padding: 6px; color: var(--dsw-alias-label-secondary); }
.rd-ask-tool-btn.is-icon:hover { color: var(--dsw-alias-label-primary); }

.rd-chat {
  display: flex; flex-direction: column; min-width: 0; min-height: 0;
  background: var(--dsw-alias-bg-base);
  border-left: 1px solid var(--dsw-alias-border-l1);
}
.rd-chat-head {
  display: flex; align-items: center; gap: 7px; flex: none;
  padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.rd-chat-head-icon { display: inline-flex; color: var(--dsw-alias-brand-primary); }
.rd-chat-head-title { font-size: 13px; font-weight: 600; }
.rd-chat-head-spacer { flex: 1; }
.rd-chat-list {
  flex: 1; min-height: 0; overflow: auto; padding: 14px 12px 6px;
  display: flex; flex-direction: column; gap: 14px;
}
.rd-chat-empty {
  margin: auto; padding: 24px 16px; text-align: center;
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  color: var(--dsw-alias-label-secondary);
}
.rd-chat-empty-icon {
  width: 44px; height: 44px; border-radius: 14px; display: flex; align-items: center; justify-content: center;
  background: color-mix(in oklab, var(--dsw-alias-brand-primary) 12%, transparent);
  color: var(--dsw-alias-brand-primary);
}
.rd-chat-empty-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.rd-chat-empty-desc { font-size: 11.5px; line-height: 1.65; max-width: 300px; }

.rd-chat-msg { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.rd-chat-msg.is-user { align-items: flex-end; }
.rd-chat-msg.is-assistant { align-items: stretch; }
.rd-chat-bubble {
  max-width: 92%; padding: 8px 11px; border-radius: 12px 12px 3px 12px;
  background: color-mix(in oklab, var(--dsw-alias-brand-primary) 12%, transparent);
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px; line-height: 1.6; word-break: break-word;
  display: flex; flex-direction: column; gap: 6px;
}
.rd-chat-question { white-space: pre-wrap; }
.rd-chat-quote {
  max-width: 100%; padding: 5px 8px; border-left: 2px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 1.55;
  background: color-mix(in oklab, var(--dsw-alias-bg-base) 60%, transparent);
  border-radius: 0 var(--rd-radius-sm) var(--rd-radius-sm) 0;
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical;
}
.rd-chat-answer { font-size: 13px; line-height: 1.72; color: var(--dsw-alias-label-primary); }
.rd-chat-answer p { margin: 0 0 .6em; }
.rd-chat-answer p:last-child { margin-bottom: 0; }
.rd-chat-thinking {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--dsw-alias-label-secondary);
}
.rd-chat-caret {
  display: inline-block; width: 7px; height: 14px; margin-left: 2px;
  background: var(--dsw-alias-brand-primary); border-radius: 2px;
  vertical-align: text-bottom; animation: rd-chat-caret 1s steps(2) infinite;
}
@keyframes rd-chat-caret { 50% { opacity: 0; } }
.rd-chat-error { font-size: 12px; }
.rd-chat-actions {
  display: flex; align-items: center; gap: 2px; flex-wrap: wrap;
  padding-top: 2px; border-top: 1px dashed var(--dsw-alias-border-l1);
}
.rd-chat-stop { display: none; }
.rd-chat-composer {
  flex: none; margin: 8px 10px 12px; padding: 8px 10px 7px;
  display: flex; flex-direction: column; gap: 4px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 2px 8px rgba(0, 0, 0, .04);
  transition: border-color .12s ease, box-shadow .12s ease;
}
.rd-chat-composer:focus-within {
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--dsw-alias-brand-primary) 12%, transparent);
}
.rd-chat-draft {
  display: flex; align-items: flex-start; gap: 6px;
  padding: 5px 7px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.rd-chat-draft-quote {
  flex: 1; min-width: 0; font-size: 11.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary);
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.rd-chat-composer .rd-chat-input {
  width: 100%; border: 0; outline: 0; background: transparent; box-shadow: none;
  padding: 2px; resize: none; min-height: 28px; max-height: 180px;
  font: inherit; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-primary);
}
.rd-chat-composer .rd-chat-input:focus { border: 0; box-shadow: none; }
.rd-chat-composer .rd-chat-input::placeholder { color: var(--dsw-alias-label-secondary); opacity: .8; }
.rd-chat-composer-row { display: flex; align-items: center; gap: 6px; }
.rd-chat-composer-spacer { flex: 1; }
.rd-chat-send {
  width: 28px; height: 28px; flex: none; border: 0; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--dsw-alias-brand-primary); color: #fff; cursor: pointer;
  transition: opacity .12s ease, background .12s ease;
}
.rd-chat-send:hover { background: color-mix(in oklab, var(--dsw-alias-brand-primary) 86%, #000); }
.rd-chat-send:disabled { opacity: .35; cursor: default; }
.rd-chat-send.is-stop {
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2);
}
.rd-chat-stop-square { width: 10px; height: 10px; border-radius: 2px; background: currentColor; }

.rd-chat-reasoning {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--rd-radius-sm);
  background: var(--dsw-alias-bg-layer-1); overflow: hidden;
}
.rd-chat-reasoning.is-live { border-color: color-mix(in oklab, var(--dsw-alias-brand-primary) 35%, var(--dsw-alias-border-l1)); }
.rd-chat-reasoning-toggle {
  display: flex; align-items: center; gap: 6px; width: 100%;
  border: 0; background: none; font: inherit; font-size: 11.5px;
  color: var(--dsw-alias-label-secondary); padding: 6px 9px; cursor: pointer; text-align: left;
}
.rd-chat-reasoning-toggle:hover { color: var(--dsw-alias-label-primary); }
.rd-chat-reasoning-meta { margin-left: auto; font-size: 10.5px; opacity: .8; }
.rd-chat-reasoning-body {
  padding: 0 10px 8px; font-size: 11.5px; line-height: 1.65;
  color: var(--dsw-alias-label-secondary); white-space: pre-wrap;
  max-height: 260px; overflow: auto;
}
.rd-chat-model { position: relative; min-width: 0; flex: none; max-width: 52%; }
.rd-chat-model-btn {
  display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
  border: 0; background: transparent;
  color: var(--dsw-alias-label-secondary); border-radius: 6px;
  padding: 4px 6px; font: inherit; font-size: 11px; cursor: pointer;
}
.rd-chat-model-btn:hover {
  background: color-mix(in oklab, var(--dsw-alias-bg-layer-1) 70%, var(--dsw-alias-label-primary));
  color: var(--dsw-alias-label-primary);
}
.rd-chat-model-label { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rd-chat-model-menu {
  position: absolute; z-index: 40; left: 0; bottom: calc(100% + 6px);
  width: min(320px, 78vw); max-height: 280px; overflow: auto; padding: 6px;
  border-radius: var(--rd-radius-md); background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l1);
  box-shadow: 0 12px 32px rgba(0, 0, 0, .18);
}
.rd-chat-model-group { display: flex; flex-direction: column; }
.rd-chat-model-group-title { padding: 6px 8px 3px; font-size: 10.5px; letter-spacing: .04em; color: var(--dsw-alias-label-secondary); }
.rd-chat-model-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  border: 0; background: none; font: inherit; font-size: 12px;
  color: var(--dsw-alias-label-primary); padding: 6px 8px;
  border-radius: var(--rd-radius-sm); cursor: pointer; text-align: left;
}
.rd-chat-model-item:hover { background: color-mix(in oklab, var(--dsw-alias-bg-layer-1) 70%, var(--dsw-alias-label-primary)); }
.rd-chat-model-item.is-active { background: color-mix(in oklab, var(--dsw-alias-brand-primary) 12%, transparent); color: var(--dsw-alias-brand-primary); }
.rd-chat-model-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rd-chat-model-item-sub {
  font-size: 10.5px; color: var(--dsw-alias-label-secondary);
  max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rd-chat-model-status { display: flex; align-items: center; gap: 6px; padding: 6px 8px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.rd-chat-model-status.is-error { color: var(--dsw-alias-state-error-primary); }
.rd-chat-model-tag { align-self: flex-start; margin-top: 2px; font-size: 10px; color: var(--dsw-alias-label-secondary); opacity: .85; }
`)
