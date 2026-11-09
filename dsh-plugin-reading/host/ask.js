/**
 * In-reader chat: one streamed model answer grounded on the selected passage,
 * plus the model directory the right-hand chat pane lists in its model picker.
 *
 * The answer uses the composition's own LLM service. The caller may name an exact
 * provider/model (the chat pane's model picker); otherwise the plugin config and
 * then the user's default model apply. Reasoning deltas are forwarded so the pane
 * can show the model's thinking process the way the main conversation does.
 */
import { chapterPlainText } from './store.js'
import { failure } from './rpc.js'

const SYSTEM_PROMPT = [
  '你是一位精通中国古代文史与古籍阅读的助手，陪伴用户精读中文书籍。',
  '回答要求：',
  '- 只依据给定的原文上下文与可靠的文史常识作答；引用原文时保持原字句。',
  '- 训诂、典故、版本等不确定之处要明确说明不确定，并给出可核查的线索。',
  '- 先给直接结论，再给依据；结构清晰，分点作答，一般不超过 400 字，除非用户要求展开。',
  '- 使用简体中文。',
].join('\n')

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000
const MODEL_LIST_TIMEOUT_MS = 5000

/** Turn one chapter into contiguous plain text with paragraph breaks. */
function chapterText(chapter) {
  return chapterPlainText(chapter)
}

/** Locate the selection inside the chapter and cut a bounded context window. */
function contextAround(chapter, quote, budget) {
  const text = chapterText(chapter)
  const needle = String(quote || '').replace(/\s+/g, ' ').trim()
  let at = -1
  if (needle.length > 0) {
    at = text.replace(/\s+/g, ' ').indexOf(needle.slice(0, 80))
  }
  if (at < 0) return text.slice(0, budget)
  const half = Math.max(200, Math.floor((budget - needle.length) / 2))
  const from = Math.max(0, at - half)
  const to = Math.min(text.length, at + needle.length + half)
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`
}

/** Build the grounded user message for one question. */
export function buildAskMessage({ book, chapter, chapterIndex, quote, question, history, budget }) {
  const parts = [`【书籍】《${book.title}》${book.author ? ` · ${book.author}` : ''}`]
  parts.push(`【章节】第 ${chapterIndex + 1} 章《${chapter.title}》`)
  const context = contextAround(chapter, quote, budget)
  if (context) parts.push('', '【原文上下文】', context)
  if (quote) parts.push('', '【选中原文】', quote)
  if (Array.isArray(history) && history.length > 0) {
    parts.push('', '【此前的问答（供参考）】')
    for (const turn of history.slice(-4)) {
      if (turn?.question) parts.push(`问：${String(turn.question).slice(0, 300)}`)
      if (turn?.answer) parts.push(`答：${String(turn.answer).slice(0, 600)}`)
    }
  }
  parts.push('', '【问题】', String(question || '请解释这段原文的含义与背景。'))
  return parts.join('\n')
}

/** Race one promise against a timeout so one slow provider cannot stall the list. */
function withTimeout(promise, ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** Create the streaming ask service and the model directory used by the chat pane. */
export function createAskService(ctx, library, config) {
  let modelsCache = null
  let modelsCacheAt = 0

  function defaultSelection() {
    try {
      return ctx.get('agentDefaultModel')?.currentSelection?.() || null
    } catch {
      return null
    }
  }

  /** List routable chat models grouped by provider (cached for a few minutes). */
  async function listModels(signal) {
    if (modelsCache && Date.now() - modelsCacheAt < MODEL_CACHE_TTL_MS) return modelsCache
    const llm = ctx.get('llm')
    if (!llm) throw failure('reading/llm-unavailable', '当前 profile 没有挂载可用的模型服务（ctx.llm 不可用）。')
    const selection = defaultSelection()
    const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
    const groups = []
    for (const provider of Array.isArray(providers) ? providers : []) {
      const id = typeof provider?.id === 'string' ? provider.id : ''
      if (!id) continue
      let models = []
      let error = null
      try {
        const list = await withTimeout(Promise.resolve(llm.listModels(id)), MODEL_LIST_TIMEOUT_MS, signal)
        models = (Array.isArray(list) ? list : []).map((model) => ({
          id: String(model.id),
          name: typeof model.name === 'string' && model.name ? model.name : String(model.id),
          description: typeof model.description === 'string' ? model.description : '',
        }))
      } catch (listError) {
        error = listError instanceof Error ? listError.message : String(listError)
        // Fall back to the default route so the picker still shows something usable.
        if (selection && selection.provider === id && selection.model) {
          models = [{ id: String(selection.model), name: String(selection.model), description: '' }]
        }
      }
      groups.push({ id, name: typeof provider.name === 'string' && provider.name ? provider.name : id, models, error })
    }
    if (groups.length === 0 && typeof config?.ask?.provider === 'string' && typeof config?.ask?.model === 'string') {
      groups.push({ id: config.ask.provider, name: config.ask.provider, models: [{ id: config.ask.model, name: config.ask.model, description: '' }], error: null })
    }
    modelsCache = { default: selection, providers: groups, at: Date.now() }
    modelsCacheAt = Date.now()
    return modelsCache
  }

  /** Stream one grounded answer as typed frames for the SSE route. */
  async function* streamAsk(input, signal) {
    const llm = ctx.get('llm')
    if (!llm) throw failure('reading/llm-unavailable', '当前 profile 没有挂载可用的模型服务（ctx.llm 不可用）。')
    const selection = defaultSelection()
    const requestedProvider = typeof input?.provider === 'string' ? input.provider.trim() : ''
    const requestedModel = typeof input?.model === 'string' ? input.model.trim() : ''
    const provider = requestedProvider || config?.ask?.provider || selection?.provider
    const model = requestedModel || config?.ask?.model || selection?.model
    if (!provider || !model) {
      throw failure('reading/model-unavailable', '没有可用的默认模型，请先在设置里选择一个模型。')
    }
    const bookId = typeof input?.id === 'string' ? input.id : ''
    if (!bookId) throw failure('reading/bad-request', '缺少书籍 id')
    const book = library.findBook(bookId)
    const content = await library.readContent(bookId)
    const chapterIndex = Math.min(
      Math.max(0, Number.isFinite(Number(input.chapterIndex)) ? Math.trunc(Number(input.chapterIndex)) : 0),
      Math.max(0, content.chapters.length - 1),
    )
    const chapter = content.chapters[chapterIndex]
    const budget = Math.min(12000, Math.max(800, Number(config?.ask?.contextChars) || 6000))
    const message = buildAskMessage({
      book,
      chapter,
      chapterIndex,
      quote: typeof input.quote === 'string' ? input.quote : '',
      question: typeof input.question === 'string' ? input.question : '',
      history: Array.isArray(input.history) ? input.history : [],
      budget,
    })
    const maxTokens = Math.min(4000, Math.max(256, Number(config?.ask?.maxTokens) || 1200))
    const reasoningEffort =
      (typeof input?.reasoningEffort === 'string' && input.reasoningEffort) ||
      config?.ask?.reasoningEffort ||
      selection?.reasoningEffort
    yield { kind: 'model', provider, model }
    const stream = llm.stream({
      provider,
      model,
      reasoningEffort,
      system: config?.ask?.systemPrompt || SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: message }] }],
      maxTokens,
      signal,
    })
    try {
      for await (const chunk of stream) {
        if (chunk.type === 'reasoning-delta' && chunk.text) yield { kind: 'reasoning', text: chunk.text }
        else if (chunk.type === 'text-delta' && chunk.text) yield { kind: 'text', text: chunk.text }
        else if (chunk.type === 'usage' && chunk.usage) yield { kind: 'usage', usage: chunk.usage }
        else if (chunk.type === 'finish') {
          const reason = chunk.reason
          if (reason?.kind === 'error') {
            throw failure('reading/ask-failed', reason.failure?.message || '模型请求失败')
          }
          if (reason?.kind === 'aborted') throw failure('reading/aborted', '回答已取消')
        }
      }
    } catch (error) {
      if (error && typeof error.code === 'string') throw error
      throw failure('reading/ask-failed', error instanceof Error ? error.message : String(error))
    }
  }

  return { streamAsk, listModels }
}
