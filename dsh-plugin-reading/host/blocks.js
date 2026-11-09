/**
 * XHTML -> safe block model for the reading renderer.
 *
 * The renderer only ever sees the block/inline shapes documented below; raw markup,
 * scripts, styles, event handlers and style attributes are dropped during conversion.
 *
 * Block model (stable, see {@link BLOCK_SCHEMA_VERSION}):
 *   inline: { text, b?, i?, u?, sup?, sub?, ruby?, href?, code? }
 *   block:  { t: 'h', level, runs } | { t: 'p', runs } | { t: 'quote', blocks }
 *         | { t: 'list', ordered, items: Inline[][] } | { t: 'hr' }
 *         | { t: 'img', src, alt? } | { t: 'blank' }
 *
 * Zero dependencies; plain modern ESM.
 */

/** Version of the block model emitted by {@link xhtmlToBlocks}. */
export const BLOCK_SCHEMA_VERSION = 1

/**
 * @typedef {Object} InlineRun
 * @property {string} text
 * @property {true} [b]
 * @property {true} [i]
 * @property {true} [u]
 * @property {true} [sup]
 * @property {true} [sub]
 * @property {string} [ruby] annotation for ruby text
 * @property {string} [href]
 * @property {true} [code]
 */

/**
 * @typedef {Object} Block
 * @property {'h'|'p'|'quote'|'list'|'hr'|'img'|'blank'} t
 * @property {number} [level] heading level (1..6)
 * @property {InlineRun[]} [runs]
 * @property {Block[]} [blocks] quote contents
 * @property {boolean} [ordered] list marker
 * @property {InlineRun[][]} [items] list items
 * @property {string} [src] image source
 * @property {string} [alt] image alt text
 */

/** Common named HTML entities. Entities outside this table and all numeric forms are decoded too. */
const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  lsquo: '\u2018',
  rsquo: '\u2019',
  sbquo: '\u201a',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bdquo: '\u201e',
  laquo: '\u00ab',
  raquo: '\u00bb',
  bull: '\u2022',
  middot: '\u00b7',
  sect: '\u00a7',
  para: '\u00b6',
  dagger: '\u2020',
  Dagger: '\u2021',
  permil: '\u2030',
  prime: '\u2032',
  Prime: '\u2033',
  deg: '\u00b0',
  plusmn: '\u00b1',
  times: '\u00d7',
  divide: '\u00f7',
  minus: '\u2212',
  frac12: '\u00bd',
  frac14: '\u00bc',
  frac34: '\u00be',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  curren: '\u00a4',
  micro: '\u00b5',
  iexcl: '\u00a1',
  iquest: '\u00bf',
  ordf: '\u00aa',
  ordm: '\u00ba',
  not: '\u00ac',
  shy: '\u00ad',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  zwnj: '\u200c',
  zwj: '\u200d',
  lrm: '\u200e',
  rlm: '\u200f',
  larr: '\u2190',
  uarr: '\u2191',
  rarr: '\u2192',
  darr: '\u2193',
  harr: '\u2194',
  le: '\u2264',
  ge: '\u2265',
  ne: '\u2260',
  infin: '\u221e',
  asymp: '\u2248',
  alpha: '\u03b1',
  beta: '\u03b2',
  gamma: '\u03b3',
  delta: '\u03b4',
  epsilon: '\u03b5',
  lambda: '\u03bb',
  mu: '\u03bc',
  pi: '\u03c0',
  sigma: '\u03c3',
  omega: '\u03c9',
  Omega: '\u03a9',
})

const ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g

/**
 * Decode HTML/XML character references (named common set + decimal + hex).
 *
 * Unknown named references are left untouched so no content is silently destroyed.
 *
 * @param {string} text source text
 * @returns {string} decoded text
 */
export function decodeHtmlEntities(text) {
  if (typeof text !== 'string' || text.indexOf('&') === -1) return text
  return text.replace(ENTITY_RE, (match, body) => {
    if (body.charCodeAt(0) === 0x23 /* '#' */) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const codePoint = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return match
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) return match
      return String.fromCodePoint(codePoint)
    }
    const value = NAMED_ENTITIES[body]
    return value === undefined ? match : value
  })
}

/** Remove control/zero-width junk that must never reach the renderer (ZWSP is kept). */
const JUNK_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufeff\u00ad]/g
function cleanText(text) {
  return text.replace(JUNK_RE, '')
}

/** Collapse HTML whitespace runs; non-breaking/thin/full-width spaces count as whitespace. */
const UNICODE_SPACES_RE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g
const WHITESPACE_RUNS_RE = /[ \t\r\n\f]+/g
function collapseWhitespace(text) {
  return text.replace(UNICODE_SPACES_RE, ' ').replace(WHITESPACE_RUNS_RE, ' ')
}

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

const RAW_TEXT_ELEMENTS = new Set(['script', 'style'])

/** Tags whose entire subtree is irrelevant to reading output. */
const SKIP_ELEMENTS = new Set([
  'script',
  'style',
  'head',
  'title',
  'meta',
  'link',
  'base',
  'noscript',
  'iframe',
  'object',
  'embed',
  'svg',
  'canvas',
  'video',
  'audio',
  'source',
  'track',
  'map',
  'area',
  'param',
  'input',
  'select',
  'textarea',
  'template',
])

/** Elements rendered as blocks; used both for `div` classification and auto-closing. */
const BLOCK_ELEMENTS = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'table',
  'tr',
  'td',
  'th',
  'thead',
  'tbody',
  'tfoot',
  'caption',
  'hr',
  'figure',
  'figcaption',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'aside',
  'nav',
  'dl',
  'dt',
  'dd',
  'address',
  'fieldset',
  'form',
  'center',
  'body',
  'html',
])

/** Transparent containers that are walked instead of being treated as inline text. */
const TRANSPARENT_CONTAINERS = new Set([
  'body',
  'html',
  'article',
  'section',
  'main',
  'header',
  'footer',
  'aside',
  'nav',
  'figure',
  'center',
  'form',
  'fieldset',
  'details',
  'summary',
  'address',
])

/** Rules for implicitly closing an open element when another starts (tolerant HTML parsing). */
const AUTO_CLOSE = {
  p: ['p'],
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  option: ['option'],
  tr: ['tr', 'td', 'th'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  thead: ['thead', 'tbody', 'tfoot', 'tr'],
  tbody: ['thead', 'tbody', 'tfoot', 'tr'],
  tfoot: ['thead', 'tbody', 'tfoot', 'tr'],
}

/** Parse an attribute list (`name="value" name2='v' name3=v name4`). */
function parseAttributes(source) {
  const attributes = Object.create(null)
  let index = 0
  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index])) index += 1
    if (index >= source.length) break
    if (source[index] === '/' || source[index] === '>') {
      index += 1
      continue
    }
    const nameStart = index
    while (index < source.length && !/[\s=/>]/.test(source[index])) index += 1
    const rawName = source.slice(nameStart, index)
    while (index < source.length && /\s/.test(source[index])) index += 1
    let value = ''
    if (source[index] === '=') {
      index += 1
      while (index < source.length && /\s/.test(source[index])) index += 1
      const quote = source[index]
      if (quote === '"' || quote === "'") {
        index += 1
        const end = source.indexOf(quote, index)
        value = end === -1 ? source.slice(index) : source.slice(index, end)
        index = end === -1 ? source.length : end + 1
      } else {
        const valueStart = index
        while (index < source.length && !/[\s/>]/.test(source[index])) index += 1
        value = source.slice(valueStart, index)
      }
    }
    if (!rawName) continue
    const name = rawName.toLowerCase()
    if (!(name in attributes)) attributes[name] = decodeHtmlEntities(value)
  }
  return attributes
}

/**
 * Tokenize HTML/XHTML into open/close/text tokens.
 * Comments, doctype/PI terms, CDATA wrappers and raw script/style bodies are handled here.
 */
function tokenizeHtml(source) {
  const tokens = []
  const lowerSource = source.toLowerCase()
  let index = 0

  const pushText = (rawText) => {
    if (!rawText) return
    const decoded = decodeHtmlEntities(rawText)
    const last = tokens[tokens.length - 1]
    if (last && last.type === 'text') last.text += decoded
    else tokens.push({ type: 'text', text: decoded })
  }

  while (index < source.length) {
    const tagStart = source.indexOf('<', index)
    if (tagStart === -1) {
      pushText(source.slice(index))
      break
    }
    if (tagStart > index) pushText(source.slice(index, tagStart))

    if (source.startsWith('<!--', tagStart)) {
      const end = source.indexOf('-->', tagStart + 4)
      index = end === -1 ? source.length : end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', tagStart)) {
      const end = source.indexOf(']]>', tagStart + 9)
      const content = end === -1 ? source.slice(tagStart + 9) : source.slice(tagStart + 9, end)
      if (content) pushText(content)
      index = end === -1 ? source.length : end + 3
      continue
    }
    if (source[tagStart + 1] === '!' || source[tagStart + 1] === '?') {
      const end = source.indexOf('>', tagStart + 2)
      index = end === -1 ? source.length : end + 1
      continue
    }

    let cursor = tagStart + 1
    let quote = ''
    while (cursor < source.length) {
      const char = source[cursor]
      if (quote) {
        if (char === quote) quote = ''
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '>') {
        break
      }
      cursor += 1
    }
    if (cursor >= source.length) {
      pushText(source.slice(tagStart))
      break
    }

    const rawTag = source.slice(tagStart + 1, cursor)
    index = cursor + 1
    if (!rawTag.trim()) continue

    const isClosing = rawTag[0] === '/'
    const trimmed = rawTag.trim()
    const selfClosing = !isClosing && trimmed.endsWith('/')
    const body = isClosing ? trimmed.slice(1) : selfClosing ? trimmed.slice(0, -1) : trimmed
    const nameMatch = /^([A-Za-z][^\s/>]*)/.exec(body)
    if (!nameMatch) continue
    const name = nameMatch[1].toLowerCase()
    if (isClosing) {
      tokens.push({ type: 'close', name })
      continue
    }

    const attrs = parseAttributes(body.slice(nameMatch[0].length))
    if (!selfClosing && RAW_TEXT_ELEMENTS.has(name)) {
      const closeStart = lowerSource.indexOf(`</${name}`, index)
      if (closeStart === -1) {
        index = source.length
      } else {
        const closeEnd = source.indexOf('>', closeStart)
        index = closeEnd === -1 ? source.length : closeEnd + 1
      }
      continue
    }
    tokens.push({
      type: 'open',
      name,
      attrs,
      selfClosing: selfClosing || VOID_ELEMENTS.has(name),
    })
  }

  return tokens
}

/** Build a tolerant element tree from tokens. Text nodes are plain strings. */
function buildTree(tokens) {
  const root = { name: '#root', attrs: Object.create(null), children: [] }
  const stack = [root]

  const appendText = (text) => {
    if (!text) return
    const parent = stack[stack.length - 1]
    const last = parent.children[parent.children.length - 1]
    if (typeof last === 'string') parent.children[parent.children.length - 1] = last + text
    else parent.children.push(text)
  }

  const shouldAutoClose = (openName, incomingName) => {
    const closable = AUTO_CLOSE[incomingName]
    if (closable && closable.includes(openName)) return true
    return openName === 'p' && BLOCK_ELEMENTS.has(incomingName) && incomingName !== 'p'
  }

  for (const token of tokens) {
    if (token.type === 'text') {
      appendText(token.text)
      continue
    }
    if (token.type === 'open') {
      while (stack.length > 1 && shouldAutoClose(stack[stack.length - 1].name, token.name)) stack.pop()
      const element = { name: token.name, attrs: token.attrs, children: [] }
      stack[stack.length - 1].children.push(element)
      if (!token.selfClosing) stack.push(element)
      continue
    }
    // close token: pop up to and including the matching element when one exists
    for (let depth = stack.length - 1; depth >= 1; depth -= 1) {
      if (stack[depth].name === token.name) {
        stack.length = depth
        break
      }
    }
  }

  return root
}

/** Raw text content of an element (entities already decoded, skipped subtrees excluded). */
function rawTextContent(node) {
  let text = ''
  for (const child of node.children) {
    if (typeof child === 'string') {
      text += child
      continue
    }
    if (SKIP_ELEMENTS.has(child.name)) continue
    text += rawTextContent(child)
  }
  return text
}

/** Collapsed, trimmed text content of an element. */
function textOf(node) {
  return collapseWhitespace(cleanText(rawTextContent(node))).trim()
}

/** First descendant element with the given tag name (namespace prefixes ignored). */
function findElement(node, tagName) {
  for (const child of node.children) {
    if (typeof child === 'string') continue
    if (child.name === tagName) return child
    const nested = findElement(child, tagName)
    if (nested) return nested
  }
  return null
}

/** Document title: first non-empty h1..h3, else the first `<title>`. */
function findDocumentTitle(root) {
  const searchHeading = (node) => {
    for (const child of node.children) {
      if (typeof child === 'string') continue
      if (/^h[1-3]$/.test(child.name)) {
        const text = textOf(child)
        if (text) return text
      }
      const nested = searchHeading(child)
      if (nested) return nested
    }
    return ''
  }
  const heading = searchHeading(root)
  if (heading) return heading
  const titleElement = findElement(root, 'title')
  if (!titleElement) return undefined
  const title = textOf(titleElement)
  return title || undefined
}

// ---------------------------------------------------------------------------
// Href / image resolution
// ---------------------------------------------------------------------------

/** Percent-decode each path segment, keeping malformed escapes verbatim. */
function decodeUriSegments(path) {
  return path
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
    .join('/')
}

/** Root-clamped path normalization (mirrors zip.js semantics, no fs access). */
function normalizeRelativePath(path) {
  const parts = []
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts.join('/')
}

/**
 * Resolve an image `src` against the containing document path.
 * External/data URLs are not representable as assets and resolve to null.
 */
function resolveImageHref(baseHref, src) {
  const raw = String(src || '').trim()
  if (!raw) return null
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) || raw.startsWith('//')) return null
  const withoutFragment = raw.split('#')[0].split('?')[0]
  if (!withoutFragment) return null
  let combined
  if (withoutFragment.startsWith('/')) {
    combined = withoutFragment.slice(1)
  } else {
    const base = String(baseHref || '').replace(/\\/g, '/')
    const baseDir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : ''
    combined = baseDir + withoutFragment
  }
  const resolved = normalizeRelativePath(decodeUriSegments(combined))
  return resolved || null
}

/** Keep only http(s) and book-relative links; dangerous schemes are dropped. */
function sanitizeHref(raw) {
  const href = typeof raw === 'string' ? raw.trim() : ''
  if (!href) return undefined
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(href)
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase()
    return scheme === 'http' || scheme === 'https' ? href : undefined
  }
  return href
}

// ---------------------------------------------------------------------------
// Inline collection
// ---------------------------------------------------------------------------

const BREAK = Symbol('inlineBreak')
const EMPTY_FORMAT = Object.freeze({})

/** Build one inline run from text + the active formatting state. */
function makeRun(text, format, ruby) {
  const run = { text }
  if (format.b) run.b = true
  if (format.i) run.i = true
  if (format.u) run.u = true
  if (format.sup) run.sup = true
  if (format.sub) run.sub = true
  if (format.code) run.code = true
  if (format.href) run.href = format.href
  if (ruby) run.ruby = ruby
  return run
}

/** True when two formatting states produce the same run flags. */
function sameFormat(a, b) {
  return (
    Boolean(a.b) === Boolean(b.b) &&
    Boolean(a.i) === Boolean(b.i) &&
    Boolean(a.u) === Boolean(b.u) &&
    Boolean(a.sup) === Boolean(b.sup) &&
    Boolean(a.sub) === Boolean(b.sub) &&
    Boolean(a.code) === Boolean(b.code) &&
    (a.href || '') === (b.href || '')
  )
}

/** Append text as one (optionally merged) inline run. */
function pushInlineText(runs, text, format) {
  if (!text) return
  const cleaned = collapseWhitespace(cleanText(text))
  if (!cleaned) return
  const previous = runs[runs.length - 1]
  if (previous && !previous[BREAK] && sameFormat(previous, format) && previous.ruby === undefined) {
    previous.text += cleaned
    return
  }
  runs.push(makeRun(cleaned, format))
}

/** Append a hard line break (from `<br>`) as its own run. */
function pushBreak(runs) {
  const run = { text: '\n' }
  Object.defineProperty(run, BREAK, { value: true, enumerable: false })
  runs.push(run)
}

/** Resolve and register one image, returning the block-ready data. */
function registerImage(element, ctx) {
  const resolved = resolveImageHref(ctx.baseHref, element.attrs.src)
  if (!resolved) return null
  let src = resolved
  if (typeof ctx.resolveImage === 'function') {
    const mapped = ctx.resolveImage(resolved)
    if (mapped === null || mapped === undefined || mapped === '') return null
    if (typeof mapped !== 'string') throw new TypeError('resolveImage must return a string or null')
    src = mapped
  }
  if (!ctx.imageSeen.has(src)) {
    ctx.imageSeen.add(src)
    ctx.imageRefs.push(src)
  }
  const alt = collapseWhitespace(cleanText(element.attrs.alt || '')).trim()
  return { src, alt }
}

/** Collect `<ruby>` base + `<rt>` annotation into a single ruby run. */
function collectRuby(element, ctx, format, runs) {
  let base = ''
  const annotations = []
  const visit = (node) => {
    for (const child of node.children) {
      if (typeof child === 'string') {
        base += child
        continue
      }
      if (child.name === 'rt' || child.name === 'rtc') {
        annotations.push(textOf(child))
        continue
      }
      if (child.name === 'rp') continue
      visit(child)
    }
  }
  visit(element)
  const baseText = collapseWhitespace(cleanText(base))
  const annotation = collapseWhitespace(cleanText(annotations.join(''))).trim()
  if (!baseText && !annotation) return
  if (!annotation) {
    pushInlineText(runs, baseText, format)
    return
  }
  if (!baseText) {
    pushInlineText(runs, annotation, format)
    return
  }
  // Keep the base formatting flags, attach the annotation to the base text.
  runs.push(makeRun(baseText, format, annotation))
}

/** Walk inline content into an ordered run list. */
function collectInline(nodes, ctx, format) {
  const runs = []
  const visit = (nodeList, activeFormat) => {
    for (const node of nodeList) {
      if (typeof node === 'string') {
        pushInlineText(runs, node, activeFormat)
        continue
      }
      const name = node.name
      if (SKIP_ELEMENTS.has(name)) continue

      switch (name) {
        case 'br':
          pushBreak(runs)
          break
        case 'img': {
          const image = registerImage(node, ctx)
          if (image) ctx.images.push(image)
          break
        }
        case 'ruby':
          collectRuby(node, ctx, activeFormat, runs)
          break
        case 'rt':
        case 'rtc':
        case 'rp':
          break
        case 'a': {
          const href = sanitizeHref(node.attrs.href)
          visit(node.children, href ? { ...activeFormat, href } : activeFormat)
          break
        }
        case 'b':
        case 'strong':
          visit(node.children, { ...activeFormat, b: true })
          break
        case 'i':
        case 'em':
        case 'cite':
          visit(node.children, { ...activeFormat, i: true })
          break
        case 'u':
        case 'ins':
          visit(node.children, { ...activeFormat, u: true })
          break
        case 'sup':
          visit(node.children, { ...activeFormat, sup: true })
          break
        case 'sub':
          visit(node.children, { ...activeFormat, sub: true })
          break
        case 'code':
        case 'kbd':
        case 'samp':
        case 'tt':
          visit(node.children, { ...activeFormat, code: true })
          break
        case 'p':
        case 'div':
        case 'ul':
        case 'ol':
        case 'blockquote':
        case 'pre':
        case 'table':
        case 'figure':
        case 'hr':
          // Malformed inline nesting: block content is not merged into the paragraph.
          break
        default:
          visit(node.children, activeFormat)
      }
    }
  }
  visit(nodes, format)
  return normalizeInlineRuns(runs)
}

/** Post-process runs: cross-run space collapsing, edge trimming, empty removal. */
function normalizeInlineRuns(runs) {
  const output = []
  for (const run of runs) {
    let text = run.text
    if (!text) continue
    const previous = output[output.length - 1]
    if (text !== '\n' && previous) {
      if (previous.text.endsWith(' ') && text.startsWith(' ')) text = text.replace(/^ +/, '')
      if (previous.text === '\n' && text.startsWith(' ')) text = text.replace(/^ +/, '')
    }
    if (!text) continue
    const copy = { text }
    for (const key of ['b', 'i', 'u', 'sup', 'sub', 'code', 'href', 'ruby']) {
      if (run[key] !== undefined) copy[key] = run[key]
    }
    output.push(copy)
  }

  if (output.length) output[0].text = output[0].text.replace(/^ +/, '')
  if (output.length) output[output.length - 1].text = output[output.length - 1].text.replace(/ +$/, '')
  while (output.length && output[output.length - 1].text === '') output.pop()
  return output.filter((run) => run.text !== '')
}

/** Strip leading/trailing hard breaks and edge spaces that would open or close a paragraph blank. */
function finalizeParagraphRuns(runs) {
  const output = runs.slice()
  while (output.length && output[0].text === '\n') output.shift()
  while (output.length && output[output.length - 1].text === '\n') output.pop()
  if (output.length) output[0].text = output[0].text.replace(/^ +/, '')
  if (output.length) output[output.length - 1].text = output[output.length - 1].text.replace(/ +$/, '')
  return output.filter((run) => run.text !== '')
}

// ---------------------------------------------------------------------------
// Block collection
// ---------------------------------------------------------------------------

function isElement(value) {
  return typeof value !== 'string' && value !== null && typeof value === 'object'
}

/** True when an element directly contains at least one block-level child. */
function hasBlockChild(element) {
  for (const child of element.children) {
    if (typeof child === 'string') continue
    if (BLOCK_ELEMENTS.has(child.name) || child.name === 'img' || child.name === 'br') return true
  }
  return false
}

/** Convert direct inline content of an element into a paragraph block. */
function emitParagraphLike(element, ctx, out, options = {}) {
  const imageMark = ctx.images.length
  const format = options.format || EMPTY_FORMAT
  const runs = finalizeParagraphRuns(collectInline(element.children, ctx, format))
  const images = ctx.images.splice(imageMark)
  const allowBlank = options.allowBlank === true

  if (runs.length) out.push({ t: 'p', runs })
  else if (!images.length && allowBlank) out.push({ t: 'blank' })
  for (const image of images) pushImageBlock(out, image)
}

/** Add an image block; alt is omitted when empty. */
function pushImageBlock(out, image) {
  const block = { t: 'img', src: image.src }
  if (image.alt) block.alt = image.alt
  out.push(block)
}

/** Flush any images collected while converting inline content into trailing blocks. */
function flushImages(ctx, out, mark) {
  const images = ctx.images.splice(mark)
  for (const image of images) pushImageBlock(out, image)
}

/** Collect `<li>` elements depth-first, flattening nested lists into document order. */
function collectListItems(listElement, ctx, items) {
  for (const child of listElement.children) {
    if (!isElement(child)) continue
    if (child.name !== 'li') {
      if (child.name === 'ul' || child.name === 'ol') collectListItems(child, ctx, items)
      continue
    }

    const inlineNodes = []
    const nestedLists = []
    const visitChild = (node) => {
      if (!isElement(node)) return
      if (node.name === 'ul' || node.name === 'ol') {
        nestedLists.push(node)
        return
      }
      if (node.name === 'div' || node.name === 'p' || node.name === 'section') {
        for (const grandChild of node.children) visitChild(grandChild)
        return
      }
      inlineNodes.push(node)
    }
    for (const grandChild of child.children) {
      if (typeof grandChild === 'string') inlineNodes.push(grandChild)
      else visitChild(grandChild)
    }

    const runs = finalizeParagraphRuns(collectInline(inlineNodes, ctx, EMPTY_FORMAT))
    if (runs.length) items.push(runs)
    for (const nested of nestedLists) collectListItems(nested, ctx, items)
  }
}

/** Flatten a table into one paragraph per row, cells joined with " | ". */
function collectTableRows(element, rows) {
  for (const child of element.children) {
    if (!isElement(child)) continue
    if (child.name === 'tr') rows.push(child)
    else if (child.name === 'thead' || child.name === 'tbody' || child.name === 'tfoot' || child.name === 'table') {
      collectTableRows(child, rows)
    }
  }
}

function emitTable(element, ctx, out) {
  const caption = findElement(element, 'caption')
  if (caption) {
    const runs = finalizeParagraphRuns(collectInline(caption.children, ctx, EMPTY_FORMAT))
    if (runs.length) out.push({ t: 'p', runs })
  }
  const rows = []
  collectTableRows(element, rows)
  for (const row of rows) {
    const cells = []
    for (const child of row.children) {
      if (!isElement(child)) continue
      if (child.name !== 'td' && child.name !== 'th') continue
      const text = textOf(child)
      if (text) cells.push(text)
    }
    if (!cells.length) continue
    out.push({ t: 'p', runs: [{ text: cells.join(' | ') }] })
  }
}

/** Convert a block-level element into zero or more blocks. */
function emitBlockElement(element, ctx, out) {
  const name = element.name
  if (SKIP_ELEMENTS.has(name)) return

  if (/^h[1-6]$/.test(name)) {
    const imageMark = ctx.images.length
    const runs = finalizeParagraphRuns(collectInline(element.children, ctx, EMPTY_FORMAT))
    if (runs.length) out.push({ t: 'h', level: Number(name[1]), runs })
    flushImages(ctx, out, imageMark)
    return
  }

  switch (name) {
    case 'p':
      emitParagraphLike(element, ctx, out, { allowBlank: true })
      return

    case 'div':
    case 'section':
    case 'article':
    case 'main':
    case 'header':
    case 'footer':
    case 'aside':
    case 'nav':
    case 'figure':
    case 'center':
    case 'form':
    case 'fieldset':
    case 'details':
    case 'summary': {
      if (hasBlockChild(element)) out.push(...walkBlocks(element.children, ctx))
      else emitParagraphLike(element, ctx, out, { allowBlank: false })
      return
    }

    case 'blockquote': {
      const imageMark = ctx.images.length
      const inner = walkBlocks(element.children, ctx)
      flushImages(ctx, out, imageMark)
      if (inner.length) out.push({ t: 'quote', blocks: inner })
      return
    }

    case 'ul':
    case 'ol': {
      const imageMark = ctx.images.length
      const items = []
      collectListItems(element, ctx, items)
      if (items.length) out.push({ t: 'list', ordered: name === 'ol', items })
      flushImages(ctx, out, imageMark)
      return
    }

    case 'li':
    case 'dd':
    case 'address':
    case 'figcaption':
    case 'dt': {
      const format = name === 'dt' ? { b: true } : EMPTY_FORMAT
      emitParagraphLike(element, ctx, out, { format, allowBlank: false })
      return
    }

    case 'dl': {
      for (const child of element.children) {
        if (!isElement(child)) continue
        if (child.name === 'dt') emitParagraphLike(child, ctx, out, { format: { b: true } })
        else if (child.name === 'dd') {
          if (hasBlockChild(child)) out.push(...walkBlocks(child.children, ctx))
          else emitParagraphLike(child, ctx, out, {})
        } else out.push(...walkBlocks([child], ctx))
      }
      return
    }

    case 'pre': {
      const raw = cleanText(rawTextContent(element)).replace(/\r\n?/g, '\n')
      const text = raw.replace(/^\n/, '').replace(/\n+$/, '')
      if (text.trim()) out.push({ t: 'p', runs: [{ text, code: true }] })
      return
    }

    case 'table':
      emitTable(element, ctx, out)
      return

    case 'hr':
      out.push({ t: 'hr' })
      return

    case 'img': {
      const image = registerImage(element, ctx)
      if (image) pushImageBlock(out, image)
      return
    }

    case 'br':
      out.push({ t: 'blank' })
      return

    default:
      if (TRANSPARENT_CONTAINERS.has(name)) {
        out.push(...walkBlocks(element.children, ctx))
        return
      }
      if (hasBlockChild(element)) {
        out.push(...walkBlocks(element.children, ctx))
        return
      }
      emitParagraphLike(element, ctx, out, { allowBlank: false })
  }
}

/** Convert a list of child nodes into blocks (text nodes become implicit paragraphs). */
function walkBlocks(nodes, ctx) {
  const out = []
  for (const node of nodes) {
    if (typeof node === 'string') {
      const text = collapseWhitespace(cleanText(node)).trim()
      if (text) out.push({ t: 'p', runs: [{ text }] })
      continue
    }
    emitBlockElement(node, ctx, out)
  }
  return out
}

/**
 * Convert one XHTML document into the renderer block model.
 *
 * @param {string} xhtml XHTML/HTML source
 * @param {{ baseHref?: string, resolveImage?: (src: string) => string | null }} [options]
 *   `baseHref` is the document path used to resolve relative image sources.
 *   `resolveImage` maps the resolved book-relative image path to a canonical id;
 *   returning null omits the image block.
 * @returns {{ title?: string, blocks: Block[], imageRefs: string[] }}
 */
export function xhtmlToBlocks(xhtml, options = {}) {
  if (typeof xhtml !== 'string') throw new TypeError('xhtmlToBlocks expects an XHTML string')
  if (options !== null && typeof options !== 'object') throw new TypeError('xhtmlToBlocks options must be an object')

  const ctx = {
    baseHref: typeof options.baseHref === 'string' ? options.baseHref : '',
    resolveImage: typeof options.resolveImage === 'function' ? options.resolveImage : null,
    imageRefs: [],
    imageSeen: new Set(),
    images: [],
  }

  const tree = buildTree(tokenizeHtml(xhtml))
  const title = findDocumentTitle(tree)
  const blocks = walkBlocks(tree.children, ctx).filter((block) => {
    if (block.t !== 'p') return true
    return block.runs.length > 0
  })

  return {
    title,
    blocks,
    imageRefs: ctx.imageRefs,
  }
}

/** Render one inline run list as plain text. */
function inlineText(runs) {
  return runs.map((run) => run.text).join('')
}

/**
 * Flatten blocks into plain text (search, length checks, accessibility fallbacks).
 *
 * Ruby annotations are not included; image blocks contribute their alt text.
 *
 * @param {Block[]} blocks block list from {@link xhtmlToBlocks}
 * @param {{ paragraphSeparator?: string }} [options]
 * @returns {string}
 */
export function blocksToPlainText(blocks, options = {}) {
  if (!Array.isArray(blocks)) throw new TypeError('blocksToPlainText expects an array of blocks')
  const separator = typeof options.paragraphSeparator === 'string' ? options.paragraphSeparator : '\n'
  const parts = []

  const visit = (list) => {
    for (const block of list) {
      switch (block.t) {
        case 'h':
        case 'p':
          parts.push(inlineText(block.runs))
          break
        case 'quote':
          visit(block.blocks || [])
          break
        case 'list': {
          const items = (block.items || []).map((runs) => inlineText(runs))
          parts.push(items.join(separator))
          break
        }
        case 'img':
          parts.push(block.alt || '')
          break
        case 'hr':
        case 'blank':
          parts.push('')
          break
        default:
          break
      }
    }
  }

  visit(blocks)
  return parts.join(separator)
}
