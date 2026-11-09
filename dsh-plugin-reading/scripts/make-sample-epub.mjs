#!/usr/bin/env node
/**
 * Build a small but realistic EPUB 3 sample for end-to-end testing:
 *   node scripts/make-sample-epub.mjs [output.epub]
 *
 * The sample exercises the pipeline: multi-chapter spine, nav + NCX, cover image,
 * inline illustration, ruby annotations, entities, blockquote, list, and a table.
 */
import { promises as fs } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const output = resolve(process.argv[2] || join(here, '..', 'test', 'sample-lunyu.epub'))

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Write one real ZIP archive with stored and deflated entries. */
function zip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.from(entry.data)
    const stored = entry.store === true
    const body = stored ? data : deflateRawSync(data)
    const method = stored ? 0 : 8
    const checksum = crc32(data)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)
    locals.push(local, body)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)
    offset += local.length + body.length
  }
  const centralBytes = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBytes, end])
}

const COVER_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
  <rect width="600" height="800" fill="#264d3d"/>
  <rect x="40" y="40" width="520" height="720" fill="none" stroke="#d8c8a8" stroke-width="3"/>
  <text x="300" y="300" fill="#f3ead7" font-size="64" text-anchor="middle" font-family="serif">論語</text>
  <text x="300" y="380" fill="#d8c8a8" font-size="28" text-anchor="middle" font-family="serif">學而篇 · 為政篇 · 里仁篇</text>
  <text x="300" y="720" fill="#b8a988" font-size="18" text-anchor="middle" font-family="serif">阅读插件测试样书</text>
</svg>`

const FIGURE_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240" viewBox="0 0 480 240">
  <rect width="480" height="240" fill="#f3ead7"/>
  <circle cx="240" cy="120" r="72" fill="#264d3d" opacity="0.15"/>
  <text x="240" y="132" fill="#264d3d" font-size="30" text-anchor="middle" font-family="serif">學而時習之</text>
</svg>`

const NAV = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">
<head><title>目录</title><link rel="stylesheet" href="style.css" type="text/css"/></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
      <li><a href="text/chapter1.xhtml">学而篇第一</a>
        <ol>
          <li><a href="text/chapter1.xhtml#sec-1-2">为学与为人</a></li>
          <li><a href="text/chapter1.xhtml#sec-1-3">孝弟为本</a></li>
        </ol>
      </li>
      <li><a href="text/chapter2.xhtml">为政篇第二</a></li>
      <li><a href="text/chapter3.xhtml">里仁篇第四</a></li>
    </ol>
  </nav>
</body>
</html>`

const NCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:reading-sample-0001"/></head>
  <docTitle><text>論語</text></docTitle>
  <navMap>
    <navPoint id="n1" playOrder="1"><navLabel><text>学而篇第一</text></navLabel><content src="text/chapter1.xhtml"/></navPoint>
    <navPoint id="n2" playOrder="2"><navLabel><text>为政篇第二</text></navLabel><content src="text/chapter2.xhtml"/></navPoint>
    <navPoint id="n3" playOrder="3"><navLabel><text>里仁篇第四</text></navLabel><content src="text/chapter3.xhtml"/></navPoint>
  </navMap>
</ncx>`

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:reading-sample-0001</dc:identifier>
    <dc:title>論語</dc:title>
    <dc:creator>孔子弟子及再传弟子</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:publisher>阅读插件测试</dc:publisher>
    <dc:description>先秦语录体散文集，阅读插件端到端测试样书。</dc:description>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="cover-image" href="images/cover.svg" media-type="image/svg+xml" properties="cover-image"/>
    <item id="figure" href="images/figure.svg" media-type="image/svg+xml"/>
    <item id="c1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="text/chapter3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c3"/>
  </spine>
</package>`

const STYLE = `body { font-family: serif; line-height: 1.8; }
h1, h2 { text-align: center; }
blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 1em; color: #555; }`

const CHAPTER1 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
<head><title>学而篇第一</title><link rel="stylesheet" href="../style.css" type="text/css"/></head>
<body>
  <h1>学而篇第一</h1>
  <p><ruby>學<rt>xué</rt></ruby>而時習之，不亦說乎？有朋自遠方來，不亦樂乎？人不知而不慍，不亦君子乎？</p>
  <p>有子曰：「其為人也孝弟，而好犯上者，鮮矣；不好犯上，而好作亂者，未之有也。」</p>
  <blockquote><p>君子務本，本立而道生。孝弟也者，其為仁之本與！</p></blockquote>
  <h2 id="sec-1-2">为学与为人</h2>
  <p>子曰：「巧言令色，鮮矣仁！」</p>
  <p>曾子曰：「吾日三省吾身：為人謀而不忠乎？與朋友交而不信乎？傳不習乎？」</p>
  <img src="../images/figure.svg" alt="學而時習之插圖"/>
  <h2 id="sec-1-3">孝弟为本</h2>
  <p>子曰：「道千乘之國：敬事而信，節用而愛人，使民以時。」</p>
  <ul><li>敬事而信</li><li>節用而愛人</li><li>使民以時</li></ul>
  <p>子曰：「弟子入則孝，出則弟，謹而信，汎愛眾，而親仁。行有餘力，則以學文。」</p>
  <table><tr><td>入</td><td>孝</td></tr><tr><td>出</td><td>弟</td></tr></table>
</body>
</html>`

const CHAPTER2 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
<head><title>为政篇第二</title><link rel="stylesheet" href="../style.css" type="text/css"/></head>
<body>
  <h1>为政篇第二</h1>
  <p>子曰：「為政以德，譬如北辰，居其所而眾星共之。」</p>
  <p>子曰：「詩三百，一言以蔽之，曰：『思無邪』。」</p>
  <p>子曰：「道之以政，齊之以刑，民免而無恥；道之以德，齊之以禮，有恥且格。」</p>
  <blockquote><p>吾十有五而志于學，三十而立，四十而不惑，五十而知天命，六十而耳順，七十而從心所欲，不踰矩。</p></blockquote>
</body>
</html>`

const CHAPTER3 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
<head><title>里仁篇第四</title><link rel="stylesheet" href="../style.css" type="text/css"/></head>
<body>
  <h1>里仁篇第四</h1>
  <p>子曰：「里仁為美。擇不處仁，焉得知？」</p>
  <p>子曰：「不仁者不可以久處約，不可以長處樂。仁者安仁，知者利仁。」</p>
  <p>子曰：「朝聞道，夕死可矣。」</p>
  <p>子曰：「君子喻於義，小人喻於利。」</p>
</body>
</html>`

const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

const archive = zip([
  { name: 'mimetype', data: 'application/epub+zip', store: true },
  { name: 'META-INF/container.xml', data: container },
  { name: 'OEBPS/content.opf', data: OPF },
  { name: 'OEBPS/nav.xhtml', data: NAV },
  { name: 'OEBPS/toc.ncx', data: NCX },
  { name: 'OEBPS/style.css', data: STYLE },
  { name: 'OEBPS/images/cover.svg', data: COVER_SVG },
  { name: 'OEBPS/images/figure.svg', data: FIGURE_SVG },
  { name: 'OEBPS/text/chapter1.xhtml', data: CHAPTER1 },
  { name: 'OEBPS/text/chapter2.xhtml', data: CHAPTER2 },
  { name: 'OEBPS/text/chapter3.xhtml', data: CHAPTER3 },
])

await fs.mkdir(dirname(output), { recursive: true })
await fs.writeFile(output, archive)
console.log(`wrote ${output} (${archive.byteLength} bytes)`)
