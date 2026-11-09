/**
 * EPUB 2 / EPUB 3 -> book model.
 *
 * The parser is intentionally dependency-free: the archive is read by `./zip.js`, the
 * packaging documents (container.xml, OPF, NCX, nav XHTML) by the small XML tree parser
 * below, and each spine document by `./blocks.js`.
 *
 * Returned shape:
 * ```js
 * {
 *   meta: { title, author?, language?, description?, publisher?, identifier? },
 *   cover: { path, mediaType, bytes } | null,
 *   chapters: Array<{ title, blocks, sourceHref, imageRefs }>,
 *   assets: Array<{ path, mediaType, bytes }>,
 *   warnings: string[],
 * }
 * ```
 *
 * All paths are percent-decoded, `..`-normalized paths inside the EPUB container.
 * Nothing is ever read from the host filesystem.
 */

import { readZip } from './zip.js'
import { xhtmlToBlocks, blocksToPlainText, decodeHtmlEntities } from './blocks.js'

const TEXT_DECODER = new TextDecoder('utf-8')
const UTF8_BOM = '\ufeff'

/** Elements that are treated as self-closing even without a trailing slash (tolerant XHTML). */
const XML_VOID_ELEMENTS = new Set([
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

/** Cover image media types the renderer can display. */
const COVER_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'])

/** Generic image extension -> media type fallback for manifest-less entries. */
const IMAGE_MEDIA_TYPES = new Map([
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
  ['svg', 'image/svg+xml'],
  ['bmp', 'image/bmp'],
  ['avif', 'image/avif'],
])

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Coerce the public input into a Buffer view without copying. */
function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  throw new TypeError('parseEpub expects a Buffer or Uint8Array')
}

/** Decode UTF-8 bytes (BOM tolerated). */
function decodeText(bytes) {
  const text = TEXT_DECODER.decode(bytes)
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Collapse whitespace the same way the block converter does (for metadata/TOC text). */
function collapseText(value) {
  return String(value || '')
    .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/[ \t\r\n\f]+/g, ' ')
    .trim()
}

/** Strip markup that survived entity decoding and collapse whitespace. */
function cleanMetadataText(value) {
  return collapseText(String(value || '').replace(/<[^>]*>/g, ' '))
}

/** Local name of a possibly namespace-prefixed XML name. */
function localName(name) {
  const index = name.lastIndexOf(':')
  return index === -1 ? name : name.slice(index + 1)
}

/** Percent-decode path segments, keeping malformed escapes verbatim. */
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

/** Resolve `.`/`..` segments, clamping at the archive root. */
function normalizePath(path) {
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

/** Directory part of a normalized path ('' at the root). */
function dirname(path) {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

/** File extension of a normalized path, lower-case, without the dot. */
function extensionOf(path) {
  const name = String(path || '').split('/').pop() || ''
  const index = name.lastIndexOf('.')
  return index === -1 ? '' : name.slice(index + 1).toLowerCase()
}

/** Best-effort image media type from the file extension. */
function guessMediaType(path) {
  return IMAGE_MEDIA_TYPES.get(extensionOf(path)) || ''
}

/** Normalize a manifest media type (`image/jpg` is a common typo for `image/jpeg`). */
function normalizeMediaType(mediaType) {
  const value = String(mediaType || '')
    .trim()
    .toLowerCase()
  if (!value) return ''
  return value === 'image/jpg' ? 'image/jpeg' : value
}

/**
 * Resolve an OPF/NCX/nav href against a directory inside the container.
 * Fragments/queries are stripped, percent escapes decoded and traversal clamped.
 *
 * @param {string} baseDir directory of the referencing document ('' for root)
 * @param {string} href raw href
 * @returns {string|null} normalized container path or null when it cannot address an entry
 */
function resolveZipPath(baseDir, href) {
  const raw = typeof href === 'string' ? href.trim() : ''
  if (!raw) return null
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return null
  const hashIndex = raw.indexOf('#')
  let withoutFragment = hashIndex === -1 ? raw : raw.slice(0, hashIndex)
  const queryIndex = withoutFragment.indexOf('?')
  if (queryIndex !== -1) withoutFragment = withoutFragment.slice(0, queryIndex)
  if (!withoutFragment) return null
  const decoded = decodeUriSegments(withoutFragment).replace(/\\/g, '/')
  const base = String(baseDir || '').replace(/\\/g, '/')
  let combined
  if (decoded.startsWith('/')) combined = decoded.slice(1)
  else combined = base ? `${base}/${decoded}` : decoded
  const normalized = normalizePath(combined)
  return normalized || null
}

// ---------------------------------------------------------------------------
// Tiny tolerant XML tree parser (container.xml, OPF, NCX, nav XHTML)
// ---------------------------------------------------------------------------

/** Parse an XML-ish document into a tree of `{ name, attrs, children }` nodes. */
function parseXml(source) {
  const root = { name: '#root', attrs: Object.create(null), children: [] }
  const stack = [root]
  let index = 0

  const appendText = (text, decode = true) => {
    if (!text) return
    const parent = stack[stack.length - 1]
    const value = decode ? decodeHtmlEntities(text) : text
    const last = parent.children[parent.children.length - 1]
    if (typeof last === 'string') parent.children[parent.children.length - 1] = last + value
    else parent.children.push(value)
  }

  while (index < source.length) {
    const tagStart = source.indexOf('<', index)
    if (tagStart === -1) {
      appendText(source.slice(index))
      break
    }
    if (tagStart > index) appendText(source.slice(index, tagStart))

    if (source.startsWith('<!--', tagStart)) {
      const end = source.indexOf('-->', tagStart + 4)
      index = end === -1 ? source.length : end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', tagStart)) {
      const end = source.indexOf(']]>', tagStart + 9)
      const content = end === -1 ? source.slice(tagStart + 9) : source.slice(tagStart + 9, end)
      appendText(content, false)
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
    if (cursor >= source.length) break

    const rawTag = source.slice(tagStart + 1, cursor)
    index = cursor + 1
    if (!rawTag.trim()) continue

    const isClosing = rawTag[0] === '/'
    const trimmed = rawTag.trim()
    const selfClosing = !isClosing && trimmed.endsWith('/')
    const body = isClosing ? trimmed.slice(1) : selfClosing ? trimmed.slice(0, -1) : trimmed
    const nameMatch = /^([A-Za-z_][^\s/>]*)/.exec(body)
    if (!nameMatch) continue
    const tagName = nameMatch[1]

    if (isClosing) {
      const target = localName(tagName).toLowerCase()
      for (let depth = stack.length - 1; depth >= 1; depth -= 1) {
        if (localName(stack[depth].name).toLowerCase() === target) {
          stack.length = depth
          break
        }
      }
      continue
    }

    const element = {
      name: tagName,
      attrs: parseXmlAttributes(body.slice(nameMatch[0].length)),
      children: [],
    }
    stack[stack.length - 1].children.push(element)
    if (!selfClosing && !XML_VOID_ELEMENTS.has(localName(tagName).toLowerCase())) stack.push(element)
  }

  return root
}

/** Parse XML attributes (lower-cased names, entity-decoded values). */
function parseXmlAttributes(source) {
  const attrs = Object.create(null)
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
    const key = rawName.toLowerCase()
    if (!(key in attrs)) attrs[key] = decodeHtmlEntities(value)
  }
  return attrs
}

/** Elements among a node's children. */
function elementChildren(node) {
  return node.children.filter((child) => typeof child !== 'string')
}

/** First descendant element with the given local name (pre-order). */
function findFirst(node, tagName) {
  const target = tagName.toLowerCase()
  for (const child of node.children) {
    if (typeof child === 'string') continue
    if (localName(child.name).toLowerCase() === target) return child
    const nested = findFirst(child, tagName)
    if (nested) return nested
  }
  return null
}

/** Visit every descendant element in pre-order. */
function walkElements(node, visitor) {
  for (const child of node.children) {
    if (typeof child === 'string') continue
    visitor(child)
    walkElements(child, visitor)
  }
}

/** Attribute lookup (attribute names are stored lower-case). */
function attr(element, name) {
  if (!element) return undefined
  const value = element.attrs[name.toLowerCase()]
  return value === undefined ? undefined : value
}

/** Concatenated text content of an element. */
function textContent(node) {
  let text = ''
  for (const child of node.children) {
    if (typeof child === 'string') text += child
    else text += textContent(child)
  }
  return text
}

/** Collapsed, trimmed text of an element (metadata labels, TOC titles, ...). */
function textOf(node) {
  return collapseText(textContent(node))
}

// ---------------------------------------------------------------------------
// Archive lookup helpers
// ---------------------------------------------------------------------------

/** Lower-case -> actual entry name index, so lookups tolerate case-only mismatches. */
function buildNameIndex(entries) {
  const index = new Map()
  for (const name of entries.keys()) {
    const key = name.toLowerCase()
    if (!index.has(key)) index.set(key, name)
  }
  return index
}

/** Find the actual archive entry name for a normalized path (case-insensitive fallback). */
function findEntryName(entries, nameIndex, path) {
  if (!path) return null
  if (entries.has(path)) return path
  const actual = nameIndex.get(String(path).toLowerCase())
  return actual === undefined ? null : actual
}

// ---------------------------------------------------------------------------
// OPF
// ---------------------------------------------------------------------------

/** Read metadata fields out of the OPF package document. */
function readMetadata(opfTree, options) {
  const metadata = findFirst(opfTree, 'metadata')
  const titles = []
  const creators = []
  const languages = []
  const identifiers = []
  let description = ''
  let publisher = ''
  let coverId = ''
  let uniqueIdentifierId = ''

  const packageElement = findFirst(opfTree, 'package')
  if (packageElement) uniqueIdentifierId = attr(packageElement, 'unique-identifier') || ''

  if (metadata) {
    walkElements(metadata, (element) => {
      const local = localName(element.name).toLowerCase()
      if (local === 'title') {
        const value = textOf(element)
        if (value) titles.push(value)
        return
      }
      if (local === 'creator') {
        const value = textOf(element)
        if (value) creators.push(value)
        return
      }
      if (local === 'language') {
        const value = textOf(element)
        if (value) languages.push(value)
        return
      }
      if (local === 'identifier') {
        identifiers.push({ id: attr(element, 'id') || '', value: textOf(element) })
        return
      }
      if (local === 'description') {
        if (!description) description = cleanMetadataText(textContent(element))
        return
      }
      if (local === 'publisher') {
        if (!publisher) publisher = cleanMetadataText(textContent(element))
        return
      }
      if (local === 'meta') {
        const name = String(attr(element, 'name') || '').toLowerCase()
        if (name === 'cover') coverId = String(attr(element, 'content') || '').trim()
      }
    })
  }

  const preferredIdentifier =
    (uniqueIdentifierId && identifiers.find((entry) => entry.id === uniqueIdentifierId)?.value) ||
    identifiers.find((entry) => entry.value)?.value ||
    ''

  return {
    titles,
    creators,
    languages,
    description,
    publisher,
    coverId,
    identifier: preferredIdentifier || options.id || '',
  }
}

/** Read `<manifest>` items into an id-keyed map plus a resolved-path lookup. */
function readManifest(opfTree, opfDir) {
  const manifestElement = findFirst(opfTree, 'manifest')
  const items = new Map()
  const byPath = new Map()
  if (!manifestElement) return { items, byPath }

  for (const element of elementChildren(manifestElement)) {
    if (localName(element.name).toLowerCase() !== 'item') continue
    const id = String(attr(element, 'id') || '').trim()
    const href = String(attr(element, 'href') || '').trim()
    if (!id || !href) continue
    const item = {
      id,
      href,
      mediaType: normalizeMediaType(attr(element, 'media-type')),
      properties: String(attr(element, 'properties') || '').trim(),
      path: resolveZipPath(opfDir, href),
    }
    items.set(id, item)
    if (item.path && !byPath.has(item.path.toLowerCase())) byPath.set(item.path.toLowerCase(), item)
  }
  return { items, byPath }
}

/** Read the spine in document order, skipping `linear="no"` items. */
function readSpine(opfTree) {
  const spineElement = findFirst(opfTree, 'spine')
  const refs = []
  if (!spineElement) return { refs, ncxId: '' }
  for (const element of elementChildren(spineElement)) {
    if (localName(element.name).toLowerCase() !== 'itemref') continue
    const idref = String(attr(element, 'idref') || '').trim()
    if (!idref) continue
    if (String(attr(element, 'linear') || '').toLowerCase() === 'no') continue
    refs.push(idref)
  }
  return { refs, ncxId: String(attr(spineElement, 'toc') || '').trim() }
}

// ---------------------------------------------------------------------------
// TOC (EPUB3 nav / EPUB2 NCX)
// ---------------------------------------------------------------------------

/** Parse an EPUB3 navigation document's toc nav into `path -> title`. */
function parseNavToc(bytes, navPath) {
  const tree = parseXml(decodeText(bytes))
  const base = dirname(navPath)
  let navElement = null

  walkElements(tree, (element) => {
    if (navElement) return
    if (localName(element.name).toLowerCase() !== 'nav') return
    const type = `${attr(element, 'epub:type') || ''} ${attr(element, 'role') || ''}`.toLowerCase()
    if (/\btoc\b/.test(type) || type.includes('doc-toc')) navElement = element
  })
  if (!navElement) {
    walkElements(tree, (element) => {
      if (!navElement && localName(element.name).toLowerCase() === 'nav') navElement = element
    })
  }
  if (!navElement) return new Map()

  const toc = new Map()
  walkElements(navElement, (element) => {
    if (localName(element.name).toLowerCase() !== 'a') return
    const href = attr(element, 'href')
    const title = textOf(element)
    if (!href || !title) return
    const resolved = resolveZipPath(base, href)
    if (resolved && !toc.has(resolved)) toc.set(resolved, title)
  })
  return toc
}

/** Parse an EPUB2 NCX document's navMap into `path -> title` (pre-order, first wins). */
function parseNcxToc(bytes, ncxPath) {
  const tree = parseXml(decodeText(bytes))
  const navMap = findFirst(tree, 'navmap')
  if (navMap) {
    const base = dirname(ncxPath)
    const toc = new Map()
    const walk = (node) => {
      for (const child of elementChildren(node)) {
        if (localName(child.name).toLowerCase() !== 'navpoint') continue
        const label = findFirst(child, 'navlabel')
        const labelText = label ? findFirst(label, 'text') : null
        const title = labelText ? textOf(labelText) : ''
        const content = findFirst(child, 'content')
        const src = attr(content, 'src')
        if (src && title) {
          const resolved = resolveZipPath(base, src)
          if (resolved && !toc.has(resolved)) toc.set(resolved, title)
        }
        walk(child)
      }
    }
    walk(navMap)
    return toc
  }
  return new Map()
}

// ---------------------------------------------------------------------------
// Chapter helpers
// ---------------------------------------------------------------------------

/** Collect image block sources from a block list (recursing into quotes). */
function collectImageRefs(blocks, refs = []) {
  for (const block of blocks) {
    if (block.t === 'img' && block.src && !refs.includes(block.src)) refs.push(block.src)
    else if (block.t === 'quote' && Array.isArray(block.blocks)) collectImageRefs(block.blocks, refs)
  }
  return refs
}

/** True when a block list contains at least one image block. */
function hasImageBlock(blocks) {
  return collectImageRefs(blocks).length > 0
}

/** Remove blank blocks at the start/end of a chapter segment. */
function trimEdgeBlankBlocks(blocks) {
  let start = 0
  let end = blocks.length
  while (start < end && blocks[start].t === 'blank') start += 1
  while (end > start && blocks[end - 1].t === 'blank') end -= 1
  return blocks.slice(start, end)
}

/** Text of a heading block's inline runs. */
function headingText(block) {
  return collapseText((block.runs || []).map((run) => run.text).join(''))
}

/**
 * Split a converted spine document at h1..h3 boundaries.
 *
 * Returns `{ split, segments }`; heading segments carry the heading text as title,
 * the leading segment (if any) has `title: null` so the caller can fall back.
 */
function splitBlocksByHeadings(blocks) {
  const headingIndexes = []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block.t === 'h' && block.level >= 1 && block.level <= 3) headingIndexes.push(index)
  }
  if (!headingIndexes.length) return { split: false, segments: [{ title: null, blocks }] }

  const segments = []
  const firstHeading = headingIndexes[0]
  if (firstHeading > 0) {
    const leading = trimEdgeBlankBlocks(blocks.slice(0, firstHeading))
    if (leading.length) segments.push({ title: null, blocks: leading })
  }
  for (let index = 0; index < headingIndexes.length; index += 1) {
    const start = headingIndexes[index]
    const end = index + 1 < headingIndexes.length ? headingIndexes[index + 1] : blocks.length
    const segment = trimEdgeBlankBlocks(blocks.slice(start, end))
    if (!segment.length) continue
    const heading = segment[0].t === 'h' ? headingText(segment[0]) : ''
    segments.push({ title: heading || null, blocks: segment })
  }
  return { split: true, segments }
}

/** True when a chapter is too thin to be worth a TOC entry. */
function isNearEmptyChapter(chapter) {
  if (hasImageBlock(chapter.blocks)) return false
  const text = blocksToPlainText(chapter.blocks).replace(/\s+/g, ' ').trim()
  return text.length < 20
}

// ---------------------------------------------------------------------------
// Classical-text heuristics (headingless 古籍 EPUBs, Gutenberg boilerplate)
// ---------------------------------------------------------------------------

/** Whole-paragraph section-heading shapes used by classical Chinese books. */
const CLASSICAL_HEADING_PATTERNS = [
  /^第[〇零一二三四五六七八九十百千两]+[章篇卷回节]$/,
  /^[\u4e00-\u9fff]{1,8}第[〇零一二三四五六七八九十百千两]+$/,
  /^【[^】]{1,12}】$/,
]

/** Over-long, headingless chapters below this size are never auto-split. */
const AUTO_SPLIT_MIN_CHARS = 6000
/** Require at least this many section headings before trusting the pattern. */
const AUTO_SPLIT_MIN_SECTIONS = 2
/** A leading fragment must carry this much text to become a 開篇 chapter. */
const AUTO_SPLIT_LEADING_MIN_CHARS = 200
/** A single title heading within this many leading blocks does not count as structure. */
const AUTO_SPLIT_LEADING_HEADING_WINDOW = 3

/** Gutenberg boilerplate is only dropped below this plain-text size (unless it is a license). */
const GUTENBERG_MAX_BOILERPLATE_CHARS = 8000
/** License-minded chapters must be at least this ASCII-letter-heavy to be considered boilerplate. */
const GUTENBERG_ASCII_RATIO = 0.6
const GUTENBERG_TITLE_RE = /(project\s+gutenberg|gutenberg|licen[cs]e)/i

/**
 * True when a paragraph's entire text looks like a classical Chinese section heading
 * (`學而第一`, `為政第二`, `第三回`, `【卷一】`, ...). Verse lines such as `1. 子曰`
 * and `一、` deliberately do not match, so numbered verses are never split points.
 *
 * @param {string} text whole paragraph text
 * @returns {boolean}
 */
export function isClassicalSectionHeading(text) {
  const value = String(text || '').trim()
  if (!value) return false
  return CLASSICAL_HEADING_PATTERNS.some((pattern) => pattern.test(value))
}

/** Share of non-whitespace characters that are plain ASCII letters. */
function asciiLetterRatio(text) {
  const compact = String(text || '').replace(/\s+/g, '')
  if (!compact) return 0
  let letters = 0
  for (const char of compact) {
    const code = char.charCodeAt(0)
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) letters += 1
  }
  return letters / compact.length
}

/**
 * True when a chapter looks like Project Gutenberg front/back matter or its license.
 *
 * Conservative on purpose: a Gutenberg marker plus a short body, or a Gutenberg/license
 * title on a predominantly ASCII (English) body. Long translated content whose title
 * merely starts with "The Project Gutenberg eBook of ..." is kept.
 *
 * @param {{ title?: string, blocks: object[] }} chapter
 * @returns {boolean}
 */
export function isGutenbergBoilerplate(chapter) {
  const title = String((chapter && chapter.title) || '')
  const blocks = Array.isArray(chapter && chapter.blocks) ? chapter.blocks : []
  const text = blocksToPlainText(blocks)
  const lowerHead = text.slice(0, 400).toLowerCase()
  const titleHitsMarker = /project\s+gutenberg/i.test(title)
  const textHitsMarker = lowerHead.includes('project gutenberg')

  if ((titleHitsMarker || textHitsMarker) && text.length < GUTENBERG_MAX_BOILERPLATE_CHARS) return true
  if (GUTENBERG_TITLE_RE.test(title) && asciiLetterRatio(text) > GUTENBERG_ASCII_RATIO) return true
  return false
}

/**
 * Split an over-long, structurally headingless chapter at classical section headings.
 *
 * Reads as "auto-split mode" only when the document is longer than
 * {@link AUTO_SPLIT_MIN_CHARS}, has no real heading structure (at most a single title
 * heading in its first blocks) and contains at least two whole-paragraph headings that
 * match {@link isClassicalSectionHeading}. The heading paragraph is promoted to an
 * `h` block (level 2) and the content after it becomes the chapter body.
 *
 * Text before the first heading becomes a leading chapter titled `開篇` when it carries
 * at least {@link AUTO_SPLIT_LEADING_MIN_CHARS} characters; otherwise it is dropped.
 *
 * @param {object[]} blocks blocks from {@link xhtmlToBlocks}
 * @returns {{ split: false } | { split: true, leading: { title: string, blocks: object[] } | null, sections: Array<{ title: string, blocks: object[] }> }}
 */
export function splitOverlongHeadinglessChapter(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return { split: false }
  if (blocksToPlainText(blocks).length <= AUTO_SPLIT_MIN_CHARS) return { split: false }

  const headingIndexes = []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block && block.t === 'h' && block.level >= 1 && block.level <= 3) headingIndexes.push(index)
  }
  // Any heading outside the title area means the book already has chapter markup.
  if (headingIndexes.some((index) => index >= AUTO_SPLIT_LEADING_HEADING_WINDOW)) return { split: false }

  const sectionStarts = []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (!block || block.t !== 'p' || !Array.isArray(block.runs)) continue
    const text = block.runs.map((run) => run.text).join('')
    if (isClassicalSectionHeading(text)) sectionStarts.push(index)
  }
  if (sectionStarts.length < AUTO_SPLIT_MIN_SECTIONS) return { split: false }

  const leadingBlocks = trimEdgeBlankBlocks(blocks.slice(0, sectionStarts[0]))
  let leading = null
  if (
    leadingBlocks.length &&
    blocksToPlainText(leadingBlocks).replace(/\s+/g, ' ').trim().length >= AUTO_SPLIT_LEADING_MIN_CHARS
  ) {
    leading = { title: '開篇', blocks: leadingBlocks }
  }

  const sections = []
  for (let index = 0; index < sectionStarts.length; index += 1) {
    const start = sectionStarts[index]
    const end = index + 1 < sectionStarts.length ? sectionStarts[index + 1] : blocks.length
    const part = trimEdgeBlankBlocks(blocks.slice(start, end))
    if (!part.length) continue
    const headingBlock = part[0]
    const title = (headingBlock.runs || []).map((run) => run.text).join('').trim()
    if (!title) continue
    const sectionBlocks = [{ t: 'h', level: 2, runs: headingBlock.runs.map((run) => ({ ...run })) }]
    if (part.length > 1) sectionBlocks.push(...part.slice(1))
    sections.push({ title, blocks: sectionBlocks })
  }
  if (sections.length < AUTO_SPLIT_MIN_SECTIONS) return { split: false }

  return { split: true, leading, sections }
}


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse an EPUB (2 or 3) archive into the reader's book model.
 *
 * @param {Uint8Array|Buffer} input raw EPUB bytes
 * @param {{ id?: string }} [opts] `id` is used as an identifier fallback
 * @returns {Promise<{
 *   meta: { title: string, author?: string, language?: string, description?: string, publisher?: string, identifier?: string },
 *   cover: { path: string, mediaType: string, bytes: Uint8Array } | null,
 *   chapters: Array<{ title: string, blocks: Array<object>, sourceHref: string, imageRefs: string[] }>,
 *   assets: Array<{ path: string, mediaType: string, bytes: Uint8Array }>,
 *   warnings: string[],
 * }>}
 */
export async function parseEpub(input, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {}
  const buffer = toBuffer(input)
  const { entries, warnings: archiveWarnings } = readZip(buffer)
  const nameIndex = buildNameIndex(entries)

  const warnings = []
  const warned = new Set()
  const warn = (message) => {
    const text = String(message)
    if (warned.has(text)) return
    warned.add(text)
    warnings.push(text)
  }
  for (const message of archiveWarnings) warn(message)

  // 1. container.xml -> rootfile full-path
  let opfPath = null
  const containerBytes = entries.get(findEntryName(entries, nameIndex, 'META-INF/container.xml') || '')
  if (containerBytes) {
    try {
      const containerTree = parseXml(decodeText(containerBytes))
      const rootfile = findFirst(containerTree, 'rootfile')
      const fullPath = rootfile ? attr(rootfile, 'full-path') : ''
      if (fullPath) opfPath = resolveZipPath('', fullPath)
    } catch (error) {
      warn(`META-INF/container.xml could not be parsed: ${error.message}`)
    }
    if (!opfPath) warn('META-INF/container.xml does not declare a usable rootfile')
  } else {
    warn('META-INF/container.xml is missing; falling back to the first *.opf entry')
  }

  if (!opfPath || !findEntryName(entries, nameIndex, opfPath)) {
    const fallback = [...entries.keys()]
      .filter((name) => /\.opf$/i.test(name))
      .sort((a, b) => a.length - b.length || a.localeCompare(b))[0]
    if (fallback) {
      if (opfPath) warn(`declared OPF "${opfPath}" is missing; using "${fallback}"`)
      opfPath = fallback
    }
  }
  if (!opfPath) throw new Error('EPUB: package document (OPF) not found')
  const actualOpfPath = findEntryName(entries, nameIndex, opfPath)
  if (!actualOpfPath) throw new Error(`EPUB: package document not found in archive: ${opfPath}`)

  const opfTree = parseXml(decodeText(entries.get(actualOpfPath)))
  const opfDir = dirname(actualOpfPath)
  const { items: manifest, byPath: manifestByPath } = readManifest(opfTree, opfDir)
  if (!manifest.size) throw new Error('EPUB: package document has no manifest items')
  const { refs: spineRefs, ncxId } = readSpine(opfTree)
  if (!spineRefs.length) throw new Error('EPUB: package document has no readable spine items')

  const metadata = readMetadata(opfTree, options)

  // 2. TOC map: resolved container path -> human title.
  const tocMap = new Map()
  const navItem = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes('nav'))
  if (navItem && navItem.path) {
    const navBytes = entries.get(findEntryName(entries, nameIndex, navItem.path) || '')
    if (navBytes) {
      try {
        for (const [path, title] of parseNavToc(navBytes, navItem.path)) {
          if (!tocMap.has(path)) tocMap.set(path, title)
        }
      } catch (error) {
        warn(`EPUB3 navigation document could not be parsed: ${error.message}`)
      }
    } else {
      warn(`EPUB3 navigation document is missing from the archive: ${navItem.path}`)
    }
  }
  const ncxItem =
    [...manifest.values()].find((item) => item.mediaType === 'application/x-dtbncx+xml') ||
    (ncxId ? manifest.get(ncxId) : undefined)
  if (ncxItem && ncxItem.path) {
    const ncxBytes = entries.get(findEntryName(entries, nameIndex, ncxItem.path) || '')
    if (ncxBytes) {
      try {
        for (const [path, title] of parseNcxToc(ncxBytes, ncxItem.path)) {
          if (!tocMap.has(path)) tocMap.set(path, title)
        }
      } catch (error) {
        warn(`EPUB2 NCX could not be parsed: ${error.message}`)
      }
    } else {
      warn(`EPUB2 NCX is missing from the archive: ${ncxItem.path}`)
    }
  }

  // 3. Chapters: every spine document is converted and optionally split at headings.
  const imageResolver = (src) => {
    if (findEntryName(entries, nameIndex, src)) return src
    warn(`image is missing from the archive: ${src}`)
    return null
  }

  const candidates = []
  for (const idref of spineRefs) {
    const item = manifest.get(idref)
    if (!item) {
      warn(`spine references unknown manifest item "${idref}"`)
      continue
    }
    if (!item.path) {
      warn(`manifest item "${idref}" has no usable href`)
      continue
    }
    const actualDocPath = findEntryName(entries, nameIndex, item.path)
    if (!actualDocPath) {
      warn(`spine document is missing from the archive: ${item.path}`)
      continue
    }
    let converted
    try {
      converted = xhtmlToBlocks(decodeText(entries.get(actualDocPath)), {
        baseHref: item.path,
        resolveImage: imageResolver,
      })
    } catch (error) {
      warn(`spine document "${item.path}" could not be converted: ${error.message}`)
      continue
    }

    const tocTitle = tocMap.get(item.path) || tocMap.get(actualDocPath) || ''
    const docTitle = converted.title || ''
    const pushCandidate = (title, blocks) => {
      candidates.push({
        title: title || undefined,
        blocks,
        sourceHref: item.path,
        imageRefs: collectImageRefs(blocks),
      })
    }

    // Classical Chinese books often use bare paragraphs as section headings.
    const autoSplit = splitOverlongHeadinglessChapter(converted.blocks)
    if (autoSplit.split) {
      const firstTitle = autoSplit.sections[0]?.title || docTitle || item.path
      warn(`auto-split chapter "${firstTitle}" into ${autoSplit.sections.length} sections`)
      if (autoSplit.leading) pushCandidate(autoSplit.leading.title, autoSplit.leading.blocks)
      for (const section of autoSplit.sections) pushCandidate(section.title, section.blocks)
      continue
    }

    const { split, segments } = splitBlocksByHeadings(converted.blocks)
    for (const segment of segments) {
      const fallbackTitle = split ? tocTitle : tocTitle || docTitle
      pushCandidate(segment.title || fallbackTitle, segment.blocks)
    }
  }

  let chosen = candidates.filter((candidate) => !isNearEmptyChapter(candidate))
  if (!chosen.length && candidates.length) {
    // A degenerate book must still open: keep the richest chapter.
    const richest = candidates.reduce((best, candidate) =>
      blocksToPlainText(candidate.blocks).length > blocksToPlainText(best.blocks).length ? candidate : best,
    )
    chosen = [richest]
    warn('every chapter looked empty; kept the richest one so the book stays readable')
  }

  // Drop Project Gutenberg front/back matter, but never leave the book empty.
  if (chosen.length) {
    const withoutBoilerplate = []
    for (const candidate of chosen) {
      if (isGutenbergBoilerplate(candidate)) {
        warn(`dropped Project Gutenberg boilerplate chapter "${candidate.title || 'untitled'}"`)
        continue
      }
      withoutBoilerplate.push(candidate)
    }
    if (withoutBoilerplate.length) chosen = withoutBoilerplate
    else warn('kept Project Gutenberg boilerplate chapters because no other readable chapters were found')
  }

  const chapters = chosen.map((candidate, index) => ({
    title: candidate.title || `第 ${index + 1} 章`,
    blocks: candidate.blocks,
    sourceHref: candidate.sourceHref,
    imageRefs: candidate.imageRefs.filter((ref) => findEntryName(entries, nameIndex, ref)),
  }))

  // 4. Cover: manifest cover-image, meta name=cover, first chapter image then cover-ish id.
  const coverCandidates = []
  const pushCoverCandidate = (path, mediaType) => {
    if (!path) return
    if (coverCandidates.some((candidate) => candidate.path.toLowerCase() === path.toLowerCase())) return
    const manifestItem = manifestByPath.get(path.toLowerCase())
    coverCandidates.push({
      path,
      mediaType: normalizeMediaType(mediaType || manifestItem?.mediaType || '') || guessMediaType(path),
    })
  }
  const coverImageItem = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes('cover-image'))
  if (coverImageItem) pushCoverCandidate(coverImageItem.path, coverImageItem.mediaType)
  if (metadata.coverId) {
    const coverItem = manifest.get(metadata.coverId)
    if (coverItem) pushCoverCandidate(coverItem.path, coverItem.mediaType)
    else warn(`cover metadata references unknown manifest item "${metadata.coverId}"`)
  }
  const firstChapterImage = chapters[0]?.imageRefs?.[0]
  if (firstChapterImage) pushCoverCandidate(firstChapterImage, '')
  for (const item of manifest.values()) {
    if (!(normalizeMediaType(item.mediaType) || guessMediaType(item.path || '')).startsWith('image/')) continue
    if (/cover/i.test(item.id) || /cover/i.test(item.href)) pushCoverCandidate(item.path, item.mediaType)
  }

  let cover = null
  for (const candidate of coverCandidates) {
    const actualCoverPath = findEntryName(entries, nameIndex, candidate.path)
    if (!actualCoverPath) continue
    const mediaType = normalizeMediaType(candidate.mediaType) || guessMediaType(actualCoverPath)
    if (!COVER_MEDIA_TYPES.has(mediaType)) {
      warn(`cover image "${candidate.path}" has unsupported media type "${mediaType || 'unknown'}"`)
      continue
    }
    cover = { path: actualCoverPath, mediaType, bytes: entries.get(actualCoverPath) }
    break
  }

  // 5. Assets: images referenced by chapter blocks, deduplicated by resolved path.
  const assetPaths = []
  const seenAssetPaths = new Set()
  for (const chapter of chapters) {
    for (const ref of chapter.imageRefs) {
      if (seenAssetPaths.has(ref)) continue
      seenAssetPaths.add(ref)
      assetPaths.push(ref)
    }
  }
  const assets = []
  for (const ref of assetPaths) {
    const actualAssetPath = findEntryName(entries, nameIndex, ref)
    if (!actualAssetPath) {
      warn(`image asset is missing from the archive: ${ref}`)
      continue
    }
    const manifestItem = manifestByPath.get(ref.toLowerCase())
    const mediaType =
      normalizeMediaType(manifestItem?.mediaType) || guessMediaType(actualAssetPath) || 'application/octet-stream'
    if (!mediaType.startsWith('image/')) warn(`image asset "${ref}" has unexpected media type "${mediaType}"`)
    assets.push({ path: ref, mediaType, bytes: entries.get(actualAssetPath) })
  }

  // 6. Assemble the book model.
  const meta = {
    title: metadata.titles[0] || 'Untitled',
    author: metadata.creators.length ? metadata.creators.join(' / ') : undefined,
    language: metadata.languages[0] || undefined,
    description: metadata.description || undefined,
    publisher: metadata.publisher || undefined,
    identifier: metadata.identifier || undefined,
  }

  if (!chapters.length) warn('no readable chapters were found in the spine')
  if (!cover) warn('no usable cover image was found')

  return {
    meta,
    cover,
    chapters,
    assets,
    warnings: [...new Set(warnings)],
  }
}
