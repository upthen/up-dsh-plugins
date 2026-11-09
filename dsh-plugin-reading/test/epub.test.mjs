/**
 * Zero-dependency test suite for the EPUB parsing pipeline.
 *
 * Run with: node test/epub.test.mjs
 *
 * EPUB fixtures are generated in memory by a tiny ZIP writer built on node:zlib, then
 * read back through the production reader. No filesystem fixtures, no test framework.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'

import { unzip, listEntries, readZip, normalizeZipPath } from '../host/zip.js'
import { xhtmlToBlocks, blocksToPlainText, decodeHtmlEntities, BLOCK_SCHEMA_VERSION } from '../host/blocks.js'
import { parseEpub, isClassicalSectionHeading, isGutenbergBoilerplate, splitOverlongHeadinglessChapter } from '../host/epub.js'

// ---------------------------------------------------------------------------
// Minimal ZIP writer (verifies the reader against independently produced archives)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let value = n
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[n] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function writeUInt64LE(buffer, offset, value) {
  const low = value % 0x100000000
  const high = Math.floor(value / 0x100000000)
  buffer.writeUInt32LE(low, offset)
  buffer.writeUInt32LE(high, offset + 4)
}

function toBytes(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value)
}

/** Build a normal (non-ZIP64) archive. `files` items: { name, data, method? }. */
function encodeZip(files) {
  const chunks = []
  const central = []
  let offset = 0

  for (const file of files) {
    const data = toBytes(file.data)
    const method = file.method ?? 8
    const stored = method === 8 ? deflateRawSync(data) : data
    const name = Buffer.from(file.name, 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    central.push({
      name,
      method,
      crc,
      compSize: stored.length,
      uncompSize: data.length,
      localOffset: offset,
    })
    chunks.push(local, name, stored)
    offset += local.length + name.length + stored.length
  }

  const directoryOffset = offset
  for (const entry of central) {
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(entry.method, 10)
    header.writeUInt16LE(0, 12)
    header.writeUInt16LE(0x21, 14)
    header.writeUInt32LE(entry.crc, 16)
    header.writeUInt32LE(entry.compSize, 20)
    header.writeUInt32LE(entry.uncompSize, 24)
    header.writeUInt16LE(entry.name.length, 28)
    header.writeUInt16LE(0, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt16LE(0, 34)
    header.writeUInt16LE(0, 36)
    header.writeUInt32LE(0, 38)
    header.writeUInt32LE(entry.localOffset, 42)
    chunks.push(header, entry.name)
    offset += header.length + entry.name.length
  }
  const directorySize = offset - directoryOffset

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(directorySize, 12)
  eocd.writeUInt32LE(directoryOffset, 16)
  eocd.writeUInt16LE(0, 20)
  chunks.push(eocd)

  return Buffer.concat(chunks)
}

/** Build an archive that uses ZIP64 sentinels and per-entry ZIP64 extra fields. */
function encodeZip64(files) {
  const chunks = []
  const central = []
  let offset = 0

  for (const file of files) {
    const data = toBytes(file.data)
    const method = file.method ?? 8
    const stored = method === 8 ? deflateRawSync(data) : data
    const name = Buffer.from(file.name, 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(45, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    central.push({ name, method, crc, compSize: stored.length, uncompSize: data.length, localOffset: offset })
    chunks.push(local, name, stored)
    offset += local.length + name.length + stored.length
  }

  const directoryOffset = offset
  for (const entry of central) {
    const extra = Buffer.alloc(4 + 24)
    extra.writeUInt16LE(0x0001, 0)
    extra.writeUInt16LE(24, 2)
    writeUInt64LE(extra, 4, entry.uncompSize)
    writeUInt64LE(extra, 12, entry.compSize)
    writeUInt64LE(extra, 20, entry.localOffset)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(45, 4)
    header.writeUInt16LE(45, 6)
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(entry.method, 10)
    header.writeUInt16LE(0, 12)
    header.writeUInt16LE(0x21, 14)
    header.writeUInt32LE(entry.crc, 16)
    header.writeUInt32LE(0xffffffff, 20)
    header.writeUInt32LE(0xffffffff, 24)
    header.writeUInt16LE(entry.name.length, 28)
    header.writeUInt16LE(extra.length, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt16LE(0, 34)
    header.writeUInt16LE(0, 36)
    header.writeUInt32LE(0, 38)
    header.writeUInt32LE(0xffffffff, 42)
    chunks.push(header, entry.name, extra)
    offset += header.length + entry.name.length + extra.length
  }
  const directorySize = offset - directoryOffset

  const zip64Offset = offset
  const zip64 = Buffer.alloc(56)
  zip64.writeUInt32LE(0x06064b50, 0)
  writeUInt64LE(zip64, 4, 44)
  zip64.writeUInt16LE(45, 12)
  zip64.writeUInt16LE(45, 14)
  zip64.writeUInt32LE(0, 16)
  zip64.writeUInt32LE(0, 20)
  writeUInt64LE(zip64, 24, files.length)
  writeUInt64LE(zip64, 32, files.length)
  writeUInt64LE(zip64, 40, directorySize)
  writeUInt64LE(zip64, 48, directoryOffset)
  chunks.push(zip64)

  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x07064b50, 0)
  locator.writeUInt32LE(0, 4)
  writeUInt64LE(locator, 8, zip64Offset)
  locator.writeUInt32LE(1, 16)
  chunks.push(locator)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(0xffff, 8)
  eocd.writeUInt16LE(0xffff, 10)
  eocd.writeUInt32LE(0xffffffff, 12)
  eocd.writeUInt32LE(0xffffffff, 16)
  eocd.writeUInt16LE(0, 20)
  chunks.push(eocd)

  return Buffer.concat(chunks)
}

// ---------------------------------------------------------------------------
// EPUB fixtures
// ---------------------------------------------------------------------------

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9])
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

function containerXml(opfPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
}

const XHTML_HEAD = '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n'

function xhtml(title, body) {
  return `${XHTML_HEAD}<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body>${body}</body></html>`
}

/** Assemble an EPUB archive. `extraFiles` items: { name, data, method? }. */
function makeEpub(extraFiles, options = {}) {
  const files = [{ name: 'mimetype', data: 'application/epub+zip', method: 0 }]
  if (options.container !== false) {
    files.push({ name: 'META-INF/container.xml', data: containerXml(options.opfPath || 'OEBPS/content.opf') })
  }
  files.push(...extraFiles)
  return encodeZip(files)
}

const OPF2 = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Old Book</dc:title>
    <dc:creator>Author A</dc:creator>
    <dc:creator>Author B</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier id="BookId">urn:uuid:book-1</dc:identifier>
    <dc:publisher>Test Press</dc:publisher>
    <dc:description>&lt;b&gt;A story&lt;/b&gt; about &amp; things.</dc:description>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="text/ch%201.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-img" href="images/cover.jpg" media-type="image/jpeg"/>
    <item id="fig" href="images/figure.png" media-type="image/png"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`

const NCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:book-1"/></head>
  <docTitle><text>Old Book</text></docTitle>
  <navMap>
    <navPoint id="n1" playOrder="1">
      <navLabel><text>Chapter One</text></navLabel>
      <content src="text/ch%201.xhtml"/>
      <navPoint id="n1-1" playOrder="2">
        <navLabel><text>Section 1.1</text></navLabel>
        <content src="text/ch%201.xhtml#s1"/>
      </navPoint>
    </navPoint>
    <navPoint id="n2" playOrder="3">
      <navLabel><text>Chapter Two</text></navLabel>
      <content src="text/ch2.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`

function epub2Fixture() {
  return makeEpub([
    { name: 'OEBPS/content.opf', data: OPF2 },
    { name: 'OEBPS/toc.ncx', data: NCX },
    {
      name: 'OEBPS/text/ch 1.xhtml',
      data: xhtml(
        'One',
        `<p>Chapter one opens with a sentence that is comfortably longer than twenty characters.</p>
         <p><img src="../images/figure.png" alt="A figure"/></p>
         <blockquote><p>Quoted line from chapter one.</p></blockquote>`,
      ),
    },
    {
      name: 'OEBPS/text/ch2.xhtml',
      data: xhtml('Two', '<p>Chapter two also has a sentence that is comfortably longer than twenty characters.</p>'),
    },
    { name: 'OEBPS/images/cover.jpg', data: JPEG_BYTES, method: 0 },
    { name: 'OEBPS/images/figure.png', data: PNG_BYTES },
  ])
}

// ---------------------------------------------------------------------------
// Tiny test runner
// ---------------------------------------------------------------------------

const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

// ---------------------------------------------------------------------------
// ZIP reader tests
// ---------------------------------------------------------------------------

test('zip: reads stored and deflated entries, lists metadata, skips directories', () => {
  const zip = encodeZip([
    { name: 'stored.txt', data: 'stored contents', method: 0 },
    { name: 'deflate.txt', data: 'deflated contents '.repeat(20), method: 8 },
    { name: 'META-INF/', data: Buffer.alloc(0), method: 0 },
    { name: '中文/文件.txt', data: 'utf8 name payload' },
  ])
  const entries = unzip(zip)
  assert.equal(Buffer.from(entries.get('stored.txt')).toString('utf8'), 'stored contents')
  assert.equal(Buffer.from(entries.get('deflate.txt')).toString('utf8'), 'deflated contents '.repeat(20))
  assert.equal(Buffer.from(entries.get('中文/文件.txt')).toString('utf8'), 'utf8 name payload')
  assert.equal(entries.has('META-INF'), false)

  const listed = listEntries(zip)
  assert.deepEqual(
    listed.map((entry) => entry.name),
    ['stored.txt', 'deflate.txt', '中文/文件.txt'],
  )
  const storedEntry = listed.find((entry) => entry.name === 'stored.txt')
  assert.equal(storedEntry.method, 0)
  assert.equal(storedEntry.uncompSize, 'stored contents'.length)
  const deflatedEntry = listed.find((entry) => entry.name === 'deflate.txt')
  assert.equal(deflatedEntry.method, 8)

  const archive = readZip(zip)
  assert.deepEqual([...archive.directories], ['META-INF'])
  assert.deepEqual(archive.warnings, [])
})

test('zip: skips unsupported compression methods gracefully', () => {
  const zip = encodeZip([
    { name: 'ok.txt', data: 'plain' },
    { name: 'bzip2.bin', data: Buffer.from([0x42, 0x5a, 0x68]), method: 12 },
  ])
  const entries = unzip(zip)
  assert.equal(Buffer.from(entries.get('ok.txt')).toString('utf8'), 'plain')
  assert.equal(entries.has('bzip2.bin'), false)

  const listed = listEntries(zip)
  assert.equal(listed.find((entry) => entry.name === 'bzip2.bin').method, 12)

  const archive = readZip(zip)
  assert.deepEqual(archive.skipped.map((entry) => entry.name), ['bzip2.bin'])
  assert.ok(archive.warnings.some((warning) => warning.includes('Unsupported compression method 12')))
})

test('zip: normalizes traversal entry names so they stay inside the archive', () => {
  assert.equal(normalizeZipPath('../../etc/passwd'), 'etc/passwd')
  assert.equal(normalizeZipPath('/a/../b/./c.txt'), 'b/c.txt')
  assert.equal(normalizeZipPath('a\\b\\..\\c.txt'), 'a/c.txt')
  assert.equal(normalizeZipPath('..'), '')

  const zip = encodeZip([{ name: '../../etc/passwd', data: 'traversal payload' }])
  const archive = readZip(zip)
  assert.equal(Buffer.from(archive.entries.get('etc/passwd')).toString('utf8'), 'traversal payload')
  assert.deepEqual(archive.unsafeNames, ['../../etc/passwd'])
})

test('zip: reads ZIP64 archives with sentinel sizes and extra fields', () => {
  const zip = encodeZip64([
    { name: 'a.txt', data: 'zip64 entry A' },
    { name: 'b.txt', data: 'zip64 entry B '.repeat(10), method: 0 },
  ])
  const entries = unzip(zip)
  assert.equal(Buffer.from(entries.get('a.txt')).toString('utf8'), 'zip64 entry A')
  assert.equal(Buffer.from(entries.get('b.txt')).toString('utf8'), 'zip64 entry B '.repeat(10))
})

test('zip: throws clear errors for non-zip and corrupt archives', () => {
  assert.throws(() => unzip(Buffer.from('this is definitely not a zip archive')), /Not a ZIP archive/)
  assert.throws(() => listEntries(Buffer.alloc(0)), /Not a ZIP archive/)
})

// ---------------------------------------------------------------------------
// Block model tests
// ---------------------------------------------------------------------------

test('blocks: collapses whitespace, keeps Chinese text intact, decodes entities', () => {
  const { blocks } = xhtmlToBlocks(
    '<p>  Hello&nbsp;&nbsp; world &amp; &#x4e2d;&#25991; &#65; &copy; &unknown; </p><p>中文  测试，保持不变。</p>',
  )
  assert.equal(blocksToPlainText(blocks), 'Hello world & 中文 A © &unknown;\n中文 测试，保持不变。')
  assert.deepEqual(blocks[0].runs, [{ text: 'Hello world & 中文 A © &unknown;' }])
  assert.equal(BLOCK_SCHEMA_VERSION, 1)
  assert.equal(decodeHtmlEntities('&#x1F600;'), '\u{1f600}')
})

test('blocks: inline formatting, code, links (http kept, javascript dropped)', () => {
  const { blocks } = xhtmlToBlocks(
    '<p><b>bold</b> <i>it</i> <u>u</u> <sup>1</sup><sub>2</sub> <code>c</code> ' +
      '<a href="https://example.com/x">ext</a> <a href="javascript:alert(1)">bad</a></p>',
  )
  const runs = blocks[0].runs
  assert.equal(blocksToPlainText(blocks), 'bold it u 12 c ext bad')
  assert.ok(runs.some((run) => run.text === 'bold' && run.b === true))
  assert.ok(runs.some((run) => run.text === 'it' && run.i === true))
  assert.ok(runs.some((run) => run.text === 'u' && run.u === true))
  assert.ok(runs.some((run) => run.text === '1' && run.sup === true))
  assert.ok(runs.some((run) => run.text === '2' && run.sub === true))
  assert.ok(runs.some((run) => run.text === 'c' && run.code === true))
  const links = runs.filter((run) => run.href !== undefined)
  assert.equal(links.length, 1)
  assert.equal(links[0].href, 'https://example.com/x')
  assert.ok(runs.some((run) => run.href === undefined && run.text.includes('bad')))
  assert.equal(JSON.stringify(runs).includes('javascript'), false)
})

test('blocks: ruby base + rt annotation, rp and rb handled', () => {
  const { blocks } = xhtmlToBlocks(
    '<p><ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby> and <ruby><rb>東</rb><rt>tou</rt></ruby></p>',
  )
  assert.deepEqual(blocks[0].runs, [
    { text: '漢', ruby: 'kan' },
    { text: ' and ' },
    { text: '東', ruby: 'tou' },
  ])
})

test('blocks: br becomes an inline newline inside the paragraph', () => {
  const { blocks } = xhtmlToBlocks('<p>line1<br/>line2</p>')
  assert.deepEqual(blocks[0].runs, [{ text: 'line1' }, { text: '\n' }, { text: 'line2' }])
  assert.equal(blocksToPlainText(blocks), 'line1\nline2')
})

test('blocks: nested lists flatten in document order', () => {
  const { blocks } = xhtmlToBlocks(
    '<ul><li>One<ul><li>Nested A</li><li>Nested B</li></ul></li><li>Two</li></ul>',
  )
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].t, 'list')
  assert.equal(blocks[0].ordered, false)
  assert.deepEqual(
    blocks[0].items.map((runs) => runs.map((run) => run.text).join('')),
    ['One', 'Nested A', 'Nested B', 'Two'],
  )
})

test('blocks: table rows flatten with pipe separators', () => {
  const { blocks } = xhtmlToBlocks(
    '<table><caption>Numbers</caption><thead><tr><th>A</th><th>B</th></tr></thead>' +
      '<tbody><tr><td>A1</td><td>B1</td></tr><tr><td>A2</td><td>B2</td></tr></tbody></table>',
  )
  assert.deepEqual(
    blocks.map((block) => blocksToPlainText([block])),
    ['Numbers', 'A | B', 'A1 | B1', 'A2 | B2'],
  )
})

test('blocks: blockquote, hr, pre and blank blocks', () => {
  const { blocks } = xhtmlToBlocks('<blockquote><p>Quoted</p></blockquote><hr/><pre>  line1\n    line2</pre><p></p><p><br/></p>')
  assert.equal(blocks[0].t, 'quote')
  assert.equal(blocks[0].blocks[0].t, 'p')
  assert.equal(blocksToPlainText(blocks).split('\n').slice(0, 3).join('|'), 'Quoted||  line1')
  const preBlock = blocks.find((block) => block.t === 'p' && block.runs[0].code)
  assert.deepEqual(preBlock.runs, [{ text: '  line1\n    line2', code: true }])
  assert.equal(blocks.filter((block) => block.t === 'blank').length, 2)
  assert.equal(blocks.find((block) => block.t === 'hr').t, 'hr')
})

test('blocks: script/style/head and dangerous attributes never reach the model', () => {
  const { title, blocks } = xhtmlToBlocks(
    '<html><head><title>T</title><style>p{color:red}</style></head><body>' +
      "<script>alert('xss')</script><p onclick=\"alert(2)\" style=\"color:red\">Safe</p>" +
      '<img src="images/a.png" onerror="alert(3)"/></body></html>',
  )
  assert.equal(title, 'T')
  const serialized = JSON.stringify(blocks)
  assert.equal(serialized.includes('alert'), false)
  assert.equal(serialized.includes('style'), false)
  assert.equal(serialized.includes('<'), false)
  assert.deepEqual(blocks[0].runs, [{ text: 'Safe' }])
  assert.deepEqual(blocks[1], { t: 'img', src: 'images/a.png' })
})

test('blocks: image refs resolve against baseHref and dedupe', () => {
  const raw = '<p><img src="../images/a.png" alt="A"/><img src="../images/a.png"/></p><img src="images/b%20c.png"/>'
  const { blocks, imageRefs } = xhtmlToBlocks(raw, { baseHref: 'OEBPS/text/ch1.xhtml' })
  assert.deepEqual(imageRefs, ['OEBPS/images/a.png', 'OEBPS/text/images/b c.png'])
  assert.deepEqual(
    blocks.filter((block) => block.t === 'img'),
    [
      { t: 'img', src: 'OEBPS/images/a.png', alt: 'A' },
      { t: 'img', src: 'OEBPS/images/a.png' },
      { t: 'img', src: 'OEBPS/text/images/b c.png' },
    ],
  )
})

test('blocks: resolveImage callback maps ids and null drops the block', () => {
  const raw = '<p><img src="one.png"/><img src="two.png"/></p>'
  const { blocks, imageRefs } = xhtmlToBlocks(raw, {
    baseHref: 'OEBPS/text/ch.xhtml',
    resolveImage: (src) => (src.endsWith('two.png') ? null : `asset:${src}`),
  })
  assert.deepEqual(imageRefs, ['asset:OEBPS/text/one.png'])
  assert.deepEqual(blocks, [{ t: 'img', src: 'asset:OEBPS/text/one.png' }])
})

test('blocks: blocksToPlainText flattens every block type', () => {
  const { blocks } = xhtmlToBlocks('<h1>Title</h1><p>One</p><ul><li>A</li><li>B</li></ul><p>Two</p>')
  assert.equal(blocksToPlainText(blocks), 'Title\nOne\nA\nB\nTwo')
  assert.equal(blocksToPlainText(blocks, { paragraphSeparator: ' / ' }), 'Title / One / A / B / Two')
})

// ---------------------------------------------------------------------------
// EPUB 2 / EPUB 3 tests
// ---------------------------------------------------------------------------

test('epub2: metadata, NCX titles, percent-encoded hrefs, cover and assets', async () => {
  const parsed = await parseEpub(epub2Fixture())

  assert.equal(parsed.meta.title, 'Old Book')
  assert.equal(parsed.meta.author, 'Author A / Author B')
  assert.equal(parsed.meta.language, 'en')
  assert.equal(parsed.meta.publisher, 'Test Press')
  assert.equal(parsed.meta.description, 'A story about & things.')
  assert.equal(parsed.meta.identifier, 'urn:uuid:book-1')

  assert.ok(parsed.cover)
  assert.equal(parsed.cover.path, 'OEBPS/images/cover.jpg')
  assert.equal(parsed.cover.mediaType, 'image/jpeg')
  assert.ok(Buffer.from(parsed.cover.bytes).equals(JPEG_BYTES))

  assert.equal(parsed.chapters.length, 2)
  assert.deepEqual(
    parsed.chapters.map((chapter) => chapter.title),
    ['Chapter One', 'Chapter Two'],
  )
  assert.deepEqual(
    parsed.chapters.map((chapter) => chapter.sourceHref),
    ['OEBPS/text/ch 1.xhtml', 'OEBPS/text/ch2.xhtml'],
  )
  assert.deepEqual(parsed.chapters[0].imageRefs, ['OEBPS/images/figure.png'])
  assert.deepEqual(parsed.chapters[1].imageRefs, [])
  assert.ok(parsed.chapters[0].blocks.some((block) => block.t === 'img' && block.src === 'OEBPS/images/figure.png'))
  assert.ok(parsed.chapters[0].blocks.some((block) => block.t === 'quote'))

  assert.equal(parsed.assets.length, 1)
  assert.equal(parsed.assets[0].path, 'OEBPS/images/figure.png')
  assert.equal(parsed.assets[0].mediaType, 'image/png')
  assert.ok(Buffer.from(parsed.assets[0].bytes).equals(PNG_BYTES))
  assert.deepEqual(parsed.warnings, [])
})

test('epub3: nav TOC (nested, first match wins) and cover-image property', async () => {
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>New Book</dc:title>
    <dc:creator>Author C</dc:creator>
    <dc:language>zh</dc:language>
    <dc:identifier id="uid">urn:uuid:book-3</dc:identifier>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="a" href="text/a.xhtml" media-type="application/xhtml+xml"/>
    <item id="b" href="text/b.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>
  </manifest>
  <spine><itemref idref="a"/><itemref idref="b"/></spine>
</package>`
  const nav = `${XHTML_HEAD}<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Nav</title></head><body>
  <nav epub:type="toc"><ol>
    <li><a href="text/a.xhtml">Alpha</a><ol><li><a href="text/a.xhtml#s1">Alpha Section</a></li></ol></li>
    <li><a href="text/b.xhtml">Beta</a></li>
  </ol></nav></body></html>`
  const zip = makeEpub([
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: nav },
    { name: 'OEBPS/text/a.xhtml', data: xhtml('A', '<p>Alpha chapter text that is comfortably longer than twenty characters.</p>') },
    { name: 'OEBPS/text/b.xhtml', data: xhtml('B', '<p>Beta chapter text that is comfortably longer than twenty characters.</p>') },
    { name: 'OEBPS/images/cover.png', data: PNG_BYTES },
  ])
  const parsed = await parseEpub(zip)
  assert.equal(parsed.meta.title, 'New Book')
  assert.equal(parsed.meta.author, 'Author C')
  assert.equal(parsed.meta.language, 'zh')
  assert.equal(parsed.meta.identifier, 'urn:uuid:book-3')
  assert.deepEqual(
    parsed.chapters.map((chapter) => chapter.title),
    ['Alpha', 'Beta'],
  )
  assert.equal(parsed.cover.path, 'OEBPS/images/cover.png')
  assert.equal(parsed.cover.mediaType, 'image/png')
  assert.deepEqual(parsed.assets, [])
})

test('epub: single spine document is split into chapters at h1..h3 boundaries', async () => {
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Split Book</dc:title></metadata>
  <manifest><item id="all" href="text/all.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="all"/></spine>
</package>`
  const all = xhtml(
    'All',
    `<p>This introduction is definitely longer than twenty characters in total.</p>
     <h1>Alpha</h1><p>Alpha content must be longer than twenty characters to survive filtering.</p>
     <h2>Beta</h2><p>Beta content must also be longer than twenty characters to survive filtering.</p>
     <h1>Gamma</h1><p>Gamma content likewise needs to exceed twenty characters for the test.</p>`,
  )
  const zip = makeEpub([
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/text/all.xhtml', data: all },
  ])
  const parsed = await parseEpub(zip)
  assert.deepEqual(
    parsed.chapters.map((chapter) => chapter.title),
    ['第 1 章', 'Alpha', 'Beta', 'Gamma'],
  )
  assert.ok(parsed.chapters.every((chapter) => chapter.sourceHref === 'OEBPS/text/all.xhtml'))
  assert.equal(parsed.chapters[1].blocks[0].t, 'h')
  assert.equal(parsed.chapters[1].blocks[0].level, 1)
  assert.equal(parsed.chapters[1].blocks[0].runs[0].text, 'Alpha')
  assert.equal(parsed.chapters[2].blocks[0].level, 2)
})

test('epub: near-empty chapters are ignored', async () => {
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Thin Book</dc:title></metadata>
  <manifest>
    <item id="front" href="text/front.xhtml" media-type="application/xhtml+xml"/>
    <item id="real" href="text/real.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="front"/><itemref idref="real"/></spine>
</package>`
  const zip = makeEpub([
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/text/front.xhtml', data: xhtml('Front', '<p>tiny</p>') },
    {
      name: 'OEBPS/text/real.xhtml',
      data: xhtml('Real Chapter', '<p>This real chapter is comfortably longer than twenty characters.</p>'),
    },
  ])
  const parsed = await parseEpub(zip)
  assert.equal(parsed.chapters.length, 1)
  assert.equal(parsed.chapters[0].title, 'Real Chapter')
})

test('epub: inline assets are deduplicated across chapters', async () => {
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Picture Book</dc:title></metadata>
  <manifest>
    <item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/>
    <item id="pic" href="images/pic.png" media-type="image/png"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`
  const body = '<p>Chapter text long enough to survive the near-empty filter.</p><p><img src="../images/pic.png"/></p>'
  const zip = makeEpub([
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/text/c1.xhtml', data: xhtml('One', body) },
    { name: 'OEBPS/text/c2.xhtml', data: xhtml('Two', body) },
    { name: 'OEBPS/images/pic.png', data: PNG_BYTES },
  ])
  const parsed = await parseEpub(zip)
  assert.equal(parsed.chapters.length, 2)
  assert.deepEqual(parsed.chapters[0].imageRefs, ['OEBPS/images/pic.png'])
  assert.deepEqual(parsed.chapters[1].imageRefs, ['OEBPS/images/pic.png'])
  assert.equal(parsed.assets.length, 1)
  assert.equal(parsed.assets[0].path, 'OEBPS/images/pic.png')
  assert.equal(parsed.assets[0].mediaType, 'image/png')
})

test('epub: cover falls back to a manifest item id containing "cover"', async () => {
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Fallback Cover</dc:title></metadata>
  <manifest>
    <item id="ch" href="text/ch.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-page" href="images/cover.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine><itemref idref="ch"/></spine>
</package>`
  const zip = makeEpub([
    { name: 'OEBPS/content.opf', data: opf },
    {
      name: 'OEBPS/text/ch.xhtml',
      data: xhtml('Chapter', '<p>A chapter with enough words to survive the emptiness filter.</p>'),
    },
    { name: 'OEBPS/images/cover.jpg', data: JPEG_BYTES },
  ])
  const parsed = await parseEpub(zip)
  assert.ok(parsed.cover)
  assert.equal(parsed.cover.path, 'OEBPS/images/cover.jpg')
  assert.equal(parsed.cover.mediaType, 'image/jpeg')
})

test('epub: SVG cover images are accepted (EPUB3 permits image/svg+xml)', async () => {
  const svgCover = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#fff"/></svg>',
    'utf8',
  )
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>SVG Cover</dc:title>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="ch" href="text/ch.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-image" href="images/cover.svg" media-type="image/svg+xml" properties="cover-image"/>
  </manifest>
  <spine><itemref idref="ch"/></spine>
</package>`
  const zip = makeEpub([
    { name: 'OEBPS/content.opf', data: opf },
    {
      name: 'OEBPS/text/ch.xhtml',
      data: xhtml('Chapter', '<p>A chapter with enough words to survive the emptiness filter.</p>'),
    },
    { name: 'OEBPS/images/cover.svg', data: svgCover, method: 0 },
  ])
  const parsed = await parseEpub(zip)
  assert.ok(parsed.cover)
  assert.equal(parsed.cover.path, 'OEBPS/images/cover.svg')
  assert.equal(parsed.cover.mediaType, 'image/svg+xml')
  assert.ok(Buffer.from(parsed.cover.bytes).equals(svgCover))
  assert.equal(parsed.warnings.some((warning) => warning.includes('unsupported media type')), false)
})

test('epub: absent cover yields null plus a warning', async () => {
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>No Cover</dc:title></metadata>
  <manifest><item id="ch" href="text/ch.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="ch"/></spine>
</package>`
  const zip = makeEpub([
    { name: 'OEBPS/content.opf', data: opf },
    {
      name: 'OEBPS/text/ch.xhtml',
      data: xhtml('Chapter', '<p>A chapter with enough words to survive the emptiness filter.</p>'),
    },
  ])
  const parsed = await parseEpub(zip)
  assert.equal(parsed.cover, null)
  assert.ok(parsed.warnings.some((warning) => warning.includes('no usable cover image')))
})

test('epub: ../ in a spine href is clamped to the archive root, never the filesystem', async () => {
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Traversal</dc:title></metadata>
  <manifest><item id="evil" href="../evil.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="evil"/></spine>
</package>`
  const zip = makeEpub([
    { name: 'OEBPS/content.opf', data: opf },
    {
      name: 'evil.xhtml',
      data: xhtml('Evil', '<p>TRAVERSAL payload that is long enough to be a real chapter body.</p>'),
    },
  ])
  const parsed = await parseEpub(zip)
  assert.equal(parsed.chapters.length, 1)
  assert.equal(parsed.chapters[0].sourceHref, 'evil.xhtml')
  assert.equal(parsed.chapters[0].sourceHref.includes('..'), false)
  assert.ok(blocksToPlainText(parsed.chapters[0].blocks).includes('TRAVERSAL'))
})

test('epub: missing container.xml falls back to the first *.opf entry', async () => {
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>No Container</dc:title></metadata>
  <manifest><item id="ch" href="text/ch.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="ch"/></spine>
</package>`
  const zip = makeEpub(
    [
      { name: 'OEBPS/content.opf', data: opf },
      {
        name: 'OEBPS/text/ch.xhtml',
        data: xhtml('Chapter', '<p>A chapter with enough words to survive the emptiness filter.</p>'),
      },
    ],
    { container: false },
  )
  const parsed = await parseEpub(zip)
  assert.equal(parsed.meta.title, 'No Container')
  assert.equal(parsed.chapters.length, 1)
  assert.ok(parsed.warnings.some((warning) => warning.includes('container.xml')))
})

test('epub: importing a non-zip buffer rejects with a clear error', async () => {
  await assert.rejects(() => parseEpub(Buffer.from('definitely not an epub')), /Not a ZIP archive/)
})

test('epub: missing OPF throws a clear error', async () => {
  const zip = makeEpub([{ name: 'META-INF/only.txt', data: 'nothing here' }])
  await assert.rejects(() => parseEpub(zip), /package document .*not found/)
})

// ---------------------------------------------------------------------------
// Classical-text heuristics (headingless 古籍 EPUBs, Gutenberg boilerplate)
// ---------------------------------------------------------------------------

const CLASSICAL_VERSE =
  '子曰：學而時習之，不亦說乎？有朋自遠方來，不亦樂乎？人不知而不慍，不亦君子乎？'

test('heuristics: classical section-heading detection is conservative', () => {
  for (const heading of ['學而第一', '為政第二', '八佾第三', '里仁第四', '第一回', '第三篇', '【卷一】']) {
    assert.equal(isClassicalSectionHeading(heading), true, heading)
  }
  for (const notHeading of [
    '1. 子曰：學而時習之',
    '一、子曰學而時習之',
    '子曰：學而時習之',
    'This is an ordinary paragraph.',
    '學而第一。',
    '',
    '   ',
  ]) {
    assert.equal(isClassicalSectionHeading(notHeading), false, JSON.stringify(notHeading))
  }
})

test('heuristics: over-long headingless chapter splits at classical headings', () => {
  const verse = CLASSICAL_VERSE.repeat(60)
  const header = 'The Project Gutenberg eBook header line. '.repeat(8)
  const blocks = [
    { t: 'p', runs: [{ text: header }] },
    { t: 'p', runs: [{ text: '學而第一' }] },
    { t: 'p', runs: [{ text: verse }] },
    { t: 'p', runs: [{ text: '為政第二' }] },
    { t: 'p', runs: [{ text: verse }] },
    { t: 'p', runs: [{ text: '八佾第三' }] },
    { t: 'p', runs: [{ text: verse }] },
  ]
  const result = splitOverlongHeadinglessChapter(blocks)
  assert.equal(result.split, true)
  assert.equal(result.leading.title, '開篇')
  assert.ok(result.leading.blocks.length >= 1)
  assert.deepEqual(
    result.sections.map((section) => section.title),
    ['學而第一', '為政第二', '八佾第三'],
  )
  assert.equal(result.sections[0].blocks[0].t, 'h')
  assert.equal(result.sections[0].blocks[0].level, 2)
  assert.equal(result.sections[0].blocks[0].runs[0].text, '學而第一')
  assert.ok(blocksToPlainText(result.sections[0].blocks).includes('學而時習之'))

  // Short documents are never auto-split.
  const shortBlocks = blocks.map((block) =>
    block.t === 'p' && block.runs[0].text.length > 100 ? { t: 'p', runs: [{ text: CLASSICAL_VERSE.repeat(5) }] } : block,
  )
  assert.equal(splitOverlongHeadinglessChapter(shortBlocks).split, false)

  // A real heading structure (h1..h3 beyond the title area) also prevents auto-splitting.
  const structured = [
    { t: 'h', level: 1, runs: [{ text: 'Book Title' }] },
    ...blocks.map((block, index) => (index === 5 ? { t: 'h', level: 2, runs: [{ text: 'Real Chapter' }] } : block)),
  ]
  assert.equal(splitOverlongHeadinglessChapter(structured).split, false)
})

test('heuristics: Gutenberg boilerplate detection only fires on real markers', () => {
  const chineseText = '子曰：學而時習之，不亦說乎？'.repeat(1000)
  const englishText = 'Updated editions will replace the previous one. '.repeat(60)
  assert.equal(
    isGutenbergBoilerplate({ title: 'The Project Gutenberg eBook of 論語', blocks: [{ t: 'p', runs: [{ text: 'This eBook is for the use of anyone anywhere.' }] }] }),
    true,
  )
  assert.equal(
    isGutenbergBoilerplate({ title: 'THE FULL PROJECT GUTENBERG™ LICENSE', blocks: [{ t: 'p', runs: [{ text: englishText }] }] }),
    true,
  )
  // Long translated content with a Gutenberg title is kept.
  assert.equal(
    isGutenbergBoilerplate({ title: 'The Project Gutenberg eBook of 唐诗三百首', blocks: [{ t: 'p', runs: [{ text: chineseText }] }] }),
    false,
  )
  assert.equal(isGutenbergBoilerplate({ title: '學而第一', blocks: [{ t: 'p', runs: [{ text: chineseText }] }] }), false)
})

test('epub: headingless classical document auto-splits and drops Gutenberg matter', async () => {
  const verse = CLASSICAL_VERSE.repeat(60)
  const header = '<p>' + 'The Project Gutenberg eBook header line. '.repeat(8) + '</p>'
  const body = `${header}<p>學而第一</p><p>${verse}</p><p>為政第二</p><p>${verse}</p><p>八佾第三</p><p>${verse}</p>`
  const license = xhtml('License', `<p>${'The Project Gutenberg License applies to this eBook. '.repeat(200)}</p>`)
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>古籍</dc:title></metadata>
  <manifest>
    <item id="content" href="text/content.xhtml" media-type="application/xhtml+xml"/>
    <item id="license" href="text/license.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="content"/><itemref idref="license"/></spine>
</package>`
  const zip = makeEpub([
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/text/content.xhtml', data: xhtml('The Project Gutenberg eBook of 古籍', body) },
    { name: 'OEBPS/text/license.xhtml', data: license },
  ])
  const parsed = await parseEpub(zip)
  assert.deepEqual(
    parsed.chapters.map((chapter) => chapter.title),
    ['學而第一', '為政第二', '八佾第三'],
  )
  assert.ok(parsed.chapters[0].blocks[0].t === 'h')
  assert.equal(parsed.chapters[0].blocks[0].level, 2)
  assert.ok(parsed.warnings.some((warning) => warning.includes('auto-split chapter "學而第一" into 3 sections')))
  assert.ok(parsed.warnings.some((warning) => warning.includes('dropped Project Gutenberg boilerplate chapter')))
  assert.equal(parsed.chapters.some((chapter) => chapter.title === '開篇'), false)
})

test('epub: Gutenberg chapters are kept when they are the only readable content', async () => {
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>License Only</dc:title></metadata>
  <manifest><item id="only" href="text/only.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="only"/></spine>
</package>`
  const only = xhtml(
    'License',
    '<p>The Project Gutenberg eBook of License Only. This text is intentionally short English boilerplate.</p>',
  )
  const zip = makeEpub([
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/text/only.xhtml', data: only },
  ])
  const parsed = await parseEpub(zip)
  assert.equal(parsed.chapters.length, 1)
  assert.ok(parsed.warnings.some((warning) => warning.includes('kept Project Gutenberg boilerplate chapters')))
})

test('epub: generated sample-lunyu.epub fixture still parses (cover, assets, text)', async () => {
  const samplePath = new URL('./sample-lunyu.epub', import.meta.url)
  if (!existsSync(samplePath)) {
    console.log('  (sample fixture missing, skipped)')
    return
  }
  const parsed = await parseEpub(readFileSync(samplePath))
  assert.equal(parsed.meta.title, '論語')
  assert.ok(parsed.chapters.length >= 3)
  assert.ok(parsed.cover)
  assert.equal(parsed.cover.mediaType, 'image/svg+xml')
  assert.ok(parsed.assets.some((asset) => asset.path === 'OEBPS/images/figure.svg'))
  assert.ok(parsed.chapters.some((chapter) => blocksToPlainText(chapter.blocks).includes('學而時習之')))
  assert.deepEqual(parsed.warnings, [])
})

let failures = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.log(`not ok - ${name}`)
    const detail = error && error.stack ? error.stack : String(error)
    for (const line of detail.split('\n').slice(0, 8)) console.log(`  ${line}`)
  }
}

console.log(`\n# tests ${tests.length}`)
console.log(`# pass ${tests.length - failures}`)
console.log(`# fail ${failures}`)
process.exitCode = failures ? 1 : 0
