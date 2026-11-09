/**
 * Minimal ZIP archive reader used by the EPUB pipeline.
 *
 * Only the features needed to read EPUB containers are implemented:
 * - End of Central Directory (EOCD) and ZIP64 EOCD records
 * - central directory + local file headers
 * - stored (method 0) and deflate (method 8) entries
 * - UTF-8 entry names (general purpose bit 11), with a latin1 fallback
 * - path normalization that cannot escape the archive root
 *
 * Unsupported compression methods (bzip2 12, lzma 14, zstd 93, ...) are skipped
 * gracefully: they appear in the directory listing but not in the unzipped map.
 *
 * Zero dependencies: only `node:zlib` is used.
 */

import zlib from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const ZIP64_EOCD_SIG = 0x06064b50
const ZIP64_LOCATOR_SIG = 0x07064b50

const EOCD_SIZE = 22
const ZIP64_LOCATOR_SIZE = 20
const ZIP64_EOCD_MIN_SIZE = 56
const MAX_EOCD_SEARCH = EOCD_SIZE + 0xffff

const FLAG_UTF8 = 0x0800

const METHOD_STORED = 0
const METHOD_DEFLATE = 8

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

/** Coerce the public input into a Buffer view without copying the bytes. */
function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  throw new TypeError('ZIP input must be a Buffer or Uint8Array')
}

/** Read an unsigned 64-bit little-endian integer as a safe JS number. */
function readUInt64LE(buffer, offset) {
  if (offset < 0 || offset + 8 > buffer.length) {
    throw new Error(`Corrupt ZIP: 64-bit field at offset ${offset} is out of bounds`)
  }
  const low = buffer.readUInt32LE(offset)
  const high = buffer.readUInt32LE(offset + 4)
  const value = high * 0x100000000 + low
  if (!Number.isSafeInteger(value)) throw new Error('Corrupt ZIP: 64-bit field exceeds Number.MAX_SAFE_INTEGER')
  return value
}

/**
 * Normalize an archive entry name so it can never address anything outside the archive.
 *
 * Backslashes become slashes, leading slashes and `.` segments are dropped and any
 * `..` segment is resolved by popping the current segment; a `..` at the root is
 * clamped rather than allowed to escape. Callers do not need to validate the result
 * before using it as a Map key.
 *
 * @param {string} name raw archive entry name
 * @returns {string} normalized, root-relative name ('' for the root itself)
 */
export function normalizeZipPath(name) {
  if (typeof name !== 'string') throw new TypeError('ZIP entry name must be a string')
  const parts = []
  for (const segment of name.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts.join('/')
}

/** Decode a raw entry name according to the archive/UTF-8 rules. */
function decodeEntryName(bytes, flags) {
  if (flags & FLAG_UTF8) return bytes.toString('utf8')
  try {
    return UTF8_DECODER.decode(bytes)
  } catch {
    return bytes.toString('latin1')
  }
}

/** Locate the End of Central Directory record, tolerating a trailing archive comment. */
function findEocdOffset(buffer) {
  const stop = Math.max(0, buffer.length - MAX_EOCD_SEARCH)
  for (let offset = buffer.length - EOCD_SIZE; offset >= stop; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIG) continue
    const commentLength = buffer.readUInt16LE(offset + 20)
    if (offset + EOCD_SIZE + commentLength <= buffer.length) return offset
  }
  throw new Error('Not a ZIP archive: end-of-central-directory record not found')
}

/** Resolve the directory location/size, upgrading through the ZIP64 records if needed. */
function readDirectoryInfo(buffer, eocdOffset) {
  let entryCount = buffer.readUInt16LE(eocdOffset + 10)
  let directorySize = buffer.readUInt32LE(eocdOffset + 12)
  let directoryOffset = buffer.readUInt32LE(eocdOffset + 16)
  const needsZip64 = entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff

  if (needsZip64) {
    const locatorOffset = eocdOffset - ZIP64_LOCATOR_SIZE
    if (locatorOffset < 0 || buffer.readUInt32LE(locatorOffset) !== ZIP64_LOCATOR_SIG) {
      throw new Error('Corrupt ZIP64 archive: ZIP64 end-of-central-directory locator is missing')
    }
    const zip64Offset = readUInt64LE(buffer, locatorOffset + 8)
    if (zip64Offset + ZIP64_EOCD_MIN_SIZE > buffer.length || buffer.readUInt32LE(zip64Offset) !== ZIP64_EOCD_SIG) {
      throw new Error('Corrupt ZIP64 archive: ZIP64 end-of-central-directory record is missing')
    }
    entryCount = readUInt64LE(buffer, zip64Offset + 32)
    directorySize = readUInt64LE(buffer, zip64Offset + 40)
    directoryOffset = readUInt64LE(buffer, zip64Offset + 48)
  }

  if (directoryOffset < 0 || directorySize < 0 || directoryOffset + directorySize > buffer.length) {
    throw new Error('Corrupt ZIP: central directory is out of bounds')
  }
  if (entryCount > buffer.length) throw new Error('Corrupt ZIP: central directory entry count is implausible')
  return { entryCount, directorySize, directoryOffset }
}

/** Parse a ZIP64 extended-information extra field for the sentinel fields we saw. */
function readZip64Extra(extra, needs, target) {
  let offset = 0
  while (offset + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(offset)
    const dataSize = extra.readUInt16LE(offset + 2)
    const dataStart = offset + 4
    const dataEnd = Math.min(extra.length, dataStart + dataSize)
    if (headerId === 0x0001) {
      let cursor = dataStart
      if (needs.uncompressedSize && cursor + 8 <= dataEnd) {
        target.uncompSize = readUInt64LE(extra, cursor)
        cursor += 8
      }
      if (needs.compressedSize && cursor + 8 <= dataEnd) {
        target.compSize = readUInt64LE(extra, cursor)
        cursor += 8
      }
      if (needs.localOffset && cursor + 8 <= dataEnd) {
        target.localOffset = readUInt64LE(extra, cursor)
        cursor += 8
      }
      if (needs.diskStart && cursor + 4 <= dataEnd) target.diskStart = extra.readUInt32LE(cursor)
      return
    }
    offset = dataStart + dataSize
  }
}

/** Read all central-directory records (no entry data is touched). */
function readCentralDirectory(buffer) {
  const { entryCount, directoryOffset } = readDirectoryInfo(buffer, findEocdOffset(buffer))
  const records = []
  let offset = directoryOffset

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length) throw new Error('Corrupt ZIP: central directory ended unexpectedly')
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new Error(`Corrupt ZIP: bad central directory header signature at offset ${offset}`)
    }
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    let compSize = buffer.readUInt32LE(offset + 20)
    let uncompSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    let diskStart = buffer.readUInt16LE(offset + 34)
    let localOffset = buffer.readUInt32LE(offset + 42)

    const nameStart = offset + 46
    const extraStart = nameStart + nameLength
    const entryEnd = extraStart + extraLength + commentLength
    if (extraStart > buffer.length || entryEnd > buffer.length) {
      throw new Error('Corrupt ZIP: central directory record is out of bounds')
    }

    const rawName = decodeEntryName(buffer.subarray(nameStart, extraStart), flags)
    const extra = buffer.subarray(extraStart, extraStart + extraLength)
    const needs = {
      uncompressedSize: uncompSize === 0xffffffff,
      compressedSize: compSize === 0xffffffff,
      localOffset: localOffset === 0xffffffff,
      diskStart: diskStart === 0xffff,
    }
    if (needs.uncompressedSize || needs.compressedSize || needs.localOffset || needs.diskStart) {
      readZip64Extra(extra, needs, {
        get uncompSize() {
          return uncompSize
        },
        set uncompSize(value) {
          uncompSize = value
        },
        get compSize() {
          return compSize
        },
        set compSize(value) {
          compSize = value
        },
        get localOffset() {
          return localOffset
        },
        set localOffset(value) {
          localOffset = value
        },
        get diskStart() {
          return diskStart
        },
        set diskStart(value) {
          diskStart = value
        },
      })
    }

    const name = normalizeZipPath(rawName)
    records.push({
      name,
      rawName,
      method,
      flags,
      compSize,
      uncompSize,
      localOffset,
      diskStart,
      isDirectory: rawName.endsWith('/') || rawName.endsWith('\\'),
    })
    offset = entryEnd
    if (offset > buffer.length) throw new Error('Corrupt ZIP: central directory is out of bounds')
  }

  return records
}

/** Extract one entry's (possibly compressed) bytes using its local file header. */
function readEntryData(buffer, record) {
  const header = record.localOffset
  if (header < 0 || header + 30 > buffer.length) {
    throw new Error(`Corrupt ZIP: local file header for "${record.rawName}" is out of bounds`)
  }
  if (buffer.readUInt32LE(header) !== LOCAL_SIG) {
    throw new Error(`Corrupt ZIP: missing local file header for "${record.rawName}"`)
  }
  const nameLength = buffer.readUInt16LE(header + 26)
  const extraLength = buffer.readUInt16LE(header + 28)
  const dataStart = header + 30 + nameLength + extraLength
  const dataEnd = dataStart + record.compSize
  if (dataEnd > buffer.length) {
    throw new Error(`Corrupt ZIP: compressed data for "${record.rawName}" is out of bounds`)
  }
  const raw = buffer.subarray(dataStart, dataEnd)

  if (record.method === METHOD_STORED) return raw
  if (record.method === METHOD_DEFLATE) {
    try {
      const inflated = zlib.inflateRawSync(raw)
      if (record.uncompSize !== 0xffffffff && inflated.length !== record.uncompSize) {
        throw new Error(`declared ${record.uncompSize} bytes, inflated ${inflated.length}`)
      }
      return inflated
    } catch (error) {
      throw new Error(`Corrupt ZIP: failed to inflate "${record.rawName}": ${error.message}`)
    }
  }
  throw new Error(`Unsupported ZIP compression method ${record.method} for "${record.rawName}"`)
}

/**
 * Full read of an archive: directory metadata, decompressed entries, directory set.
 *
 * Entry names are normalized with {@link normalizeZipPath}; entries whose normalized
 * name would collide keep the first one. Unsupported compression methods are skipped
 * and reported through `skipped`, with a human-readable `warnings` list.
 *
 * @param {Buffer|Uint8Array} input archive bytes
 * @returns {{
 *   entries: Map<string, Uint8Array>,
 *   directories: Set<string>,
 *   skipped: Array<{ name: string, method: number }>,
 *   warnings: string[],
 *   unsafeNames: string[],
 *   comment: string,
 * }}
 */
export function readZip(input) {
  const buffer = toBuffer(input)
  const eocdOffset = findEocdOffset(buffer)
  const records = readCentralDirectory(buffer)
  const entries = new Map()
  const directories = new Set()
  const skipped = []
  const warnings = []
  const unsafeNames = []

  for (const record of records) {
    if (record.name !== record.rawName.replace(/\\/g, '/').replace(/^\/+/, '')) {
      if (record.rawName.includes('..') || /^[/\\]/.test(record.rawName)) unsafeNames.push(record.rawName)
    }
    if (record.isDirectory) {
      if (record.name) directories.add(record.name)
      continue
    }
    if (record.method !== METHOD_STORED && record.method !== METHOD_DEFLATE) {
      skipped.push({ name: record.name, method: record.method })
      warnings.push(`Unsupported compression method ${record.method} for "${record.name}" (entry skipped)`)
      continue
    }
    if (entries.has(record.name)) {
      warnings.push(`Duplicate ZIP entry "${record.name}" (first occurrence kept)`)
      continue
    }
    entries.set(record.name, readEntryData(buffer, record))
  }

  const commentLength = buffer.readUInt16LE(eocdOffset + 20)
  const comment = buffer.subarray(eocdOffset + EOCD_SIZE, eocdOffset + EOCD_SIZE + commentLength).toString('utf8')

  return { entries, directories, skipped, warnings, unsafeNames, comment }
}

/**
 * Decompress every supported file entry of a ZIP archive.
 *
 * Directory entries, unsupported compression methods and entries whose data cannot
 * be inflated are not present in the returned map (corrupt data throws instead).
 *
 * @param {Buffer|Uint8Array} input archive bytes
 * @returns {Map<string, Uint8Array>} normalized entry name -> decompressed bytes
 */
export function unzip(input) {
  return readZip(input).entries
}

/**
 * List the file entries declared by the central directory without decompressing.
 *
 * Directory entries are excluded (see {@link readZip} for the directory set); entries
 * using unsupported compression are still listed so callers can diagnose them.
 *
 * @param {Buffer|Uint8Array} input archive bytes
 * @returns {Array<{ name: string, method: number, compSize: number, uncompSize: number }>}
 */
export function listEntries(input) {
  const records = readCentralDirectory(toBuffer(input))
  return records
    .filter((record) => !record.isDirectory)
    .map((record) => ({
      name: record.name,
      method: record.method,
      compSize: record.compSize,
      uncompSize: record.uncompSize,
    }))
}
