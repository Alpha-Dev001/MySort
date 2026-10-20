/**
 * Generates every raster asset MySort ships from `logo.svg`.
 *
 * The SVG is the single source of truth for the mark (the renderer imports it
 * directly). The Windows installer and the system tray need raster versions of
 * the same drawing, and there is no image toolchain in this repository — so
 * this script rasterises the SVG itself.
 *
 * It is a build-time tool, not application code: it is not bundled into
 * `out/`, and it runs only when someone asks for fresh icons.
 *
 *   node scripts/generate-icons.mjs
 *
 * Output:
 *   assets/icon.png        512x512  application / installer icon
 *   assets/icon.ico        16..256  multi-size Windows icon
 *   assets/tray.png        16x16    system tray icon
 *   assets/tray@2x.png     32x32    system tray icon at 200%
 *
 * Everything is written with Node's built-in zlib; no image dependency is
 * added to the application.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SVG_PATH = path.join(ROOT, 'logo.svg')
const OUT_DIR = path.join(ROOT, 'assets')

// ---------------------------------------------------------------------------
// SVG path parsing (absolute M / L / H / V / Q / Z only)
// ---------------------------------------------------------------------------

/**
 * @param {string} d
 * @returns {Array<Array<[number, number]>>} contours of flattened points
 */
function parsePath(d) {
  const tokens = d.match(/[MLHVQZmlhvqz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []
  const contours = []
  let current = null
  let x = 0
  let y = 0
  let i = 0
  let cmd = ''

  const num = () => {
    const t = tokens[i++]
    if (t === undefined) throw new Error(`unexpected end of path data: ${d}`)
    return Number(t)
  }

  const lineTo = (nx, ny) => {
    x = nx
    y = ny
    current.push([x, y])
  }

  while (i < tokens.length) {
    const t = tokens[i]
    if (/^[MLHVQZ]$/.test(t)) {
      cmd = t
      i++
    } else if (cmd === '') {
      throw new Error(`path data starts with a number: ${d}`)
    }

    switch (cmd) {
      case 'M': {
        x = num()
        y = num()
        current = [[x, y]]
        contours.push(current)
        cmd = 'L' // an implicit move-to is followed by line-to
        break
      }
      case 'L': {
        lineTo(num(), num())
        break
      }
      case 'H': {
        lineTo(num(), y)
        break
      }
      case 'V': {
        lineTo(x, num())
        break
      }
      case 'Q': {
        const cx = num()
        const cy = num()
        const nx = num()
        const ny = num()
        // Flatten the quadratic into a polyline: 24 segments is far below the
        // resolution of a 512px raster, so the curve stays smooth.
        const SEGMENTS = 24
        const x0 = x
        const y0 = y
        for (let s = 1; s <= SEGMENTS; s++) {
          const t = s / SEGMENTS
          const mt = 1 - t
          const px = mt * mt * x0 + 2 * mt * t * cx + t * t * nx
          const py = mt * mt * y0 + 2 * mt * t * cy + t * t * ny
          current.push([px, py])
        }
        x = nx
        y = ny
        break
      }
      case 'Z': {
        current = null
        break
      }
      default:
        throw new Error(`unsupported path command "${cmd}" in ${d}`)
    }
  }
  return contours
}

/** @returns {Array<{d: string, fill: string, opacity: number}>} */
function readPaths(svg) {
  const out = []
  const re = /<path\b([^>]*)\/?>/g
  let m
  while ((m = re.exec(svg)) !== null) {
    const attrs = m[1]
    const d = /d="([^"]+)"/.exec(attrs)?.[1]
    if (!d) continue
    const fill = /fill="([^"]+)"/.exec(attrs)?.[1] ?? '#000000'
    const opacity = Number(/opacity="([^"]+)"/.exec(attrs)?.[1] ?? '1')
    out.push({ d, fill, opacity })
  }
  return out
}

/** The named colours the mark uses. Anything else is a bug in the SVG. */
const NAMED_COLORS = {
  white: [255, 255, 255],
  black: [0, 0, 0],
  transparent: [0, 0, 0],
}

/** '#7F4EEC' -> [127, 78, 236] */
function parseColor(fill) {
  const named = NAMED_COLORS[fill.toLowerCase()]
  if (named) return named
  const hex = /^#([0-9a-f]{6})$/i.exec(fill)
  if (!hex) throw new Error(`unsupported fill "${fill}"`)
  const n = parseInt(hex[1], 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

// ---------------------------------------------------------------------------
// Rasterisation
// ---------------------------------------------------------------------------

/**
 * Scanline fill of one contour set, sampled SUBSAMPLES times per axis.
 * Returns a Float32Array of per-pixel coverage in [0, 1].
 */
function rasterise(contours, width, height, viewBox, subsamples = 3) {
  const [vbX, vbY, vbW, vbH] = viewBox
  const scale = Math.min(width / vbW, height / vbH)
  const offsetX = (width - vbW * scale) / 2
  const offsetY = (height - vbH * scale) / 2

  const edges = []
  for (const contour of contours) {
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i]
      const b = contour[(i + 1) % contour.length]
      const ax = offsetX + (a[0] - vbX) * scale
      const ay = offsetY + (a[1] - vbY) * scale
      const bx = offsetX + (b[0] - vbX) * scale
      const by = offsetY + (b[1] - vbY) * scale
      if (ay === by) continue // horizontal edges never cross a scanline
      edges.push({ ax, ay, bx, by })
    }
  }

  const coverage = new Float32Array(width * height)
  const step = 1 / subsamples
  const samplesPerRow = subsamples * subsamples

  for (let py = 0; py < height; py++) {
    for (let sy = 0; sy < subsamples; sy++) {
      const y = py + (sy + 0.5) * step
      // Collect the x positions where this scanline crosses the outline.
      const xs = []
      for (const e of edges) {
        const { ax, ay, bx, by } = e
        if (ay < by ? y >= ay && y < by : y >= by && y < ay) {
          const t = (y - ay) / (by - ay)
          xs.push(ax + t * (bx - ax))
        }
      }
      if (xs.length < 2) continue
      xs.sort((p, q) => p - q)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xStart = xs[k]
        const xEnd = xs[k + 1]
        for (let px = 0; px < width; px++) {
          for (let sx = 0; sx < subsamples; sx++) {
            const x = px + (sx + 0.5) * step
            if (x >= xStart && x < xEnd) coverage[py * width + px] += 1 / samplesPerRow
          }
        }
      }
    }
  }
  return coverage
}

/**
 * Renders the SVG paths into an RGBA buffer.
 * @returns {Uint8Array} width * height * 4
 */
function render(paths, width, height, viewBox) {
  const rgba = new Uint8Array(width * height * 4)
  for (const path of paths) {
    const contours = parsePath(path.d)
    const coverage = rasterise(contours, width, height, viewBox)
    const [r, g, b] = parseColor(path.fill)
    const alpha = path.opacity
    for (let i = 0; i < width * height; i++) {
      const c = coverage[i]
      if (c <= 0) continue
      const a = Math.min(1, c) * alpha
      const o = i * 4
      // Source-over compositing onto whatever is already there.
      const dstA = rgba[o + 3] / 255
      const outA = a + dstA * (1 - a)
      if (outA <= 0) continue
      rgba[o] = Math.round((r * a + rgba[o] * dstA * (1 - a)) / outA)
      rgba[o + 1] = Math.round((g * a + rgba[o + 1] * dstA * (1 - a)) / outA)
      rgba[o + 2] = Math.round((b * a + rgba[o + 2] * dstA * (1 - a)) / outA)
      rgba[o + 3] = Math.round(outA * 255)
    }
  }
  return rgba
}

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function encodePng(rgba, width, height) {
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter type: none
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------------
// ICO encoding (PNG-compressed entries; supported since Windows Vista)
// ---------------------------------------------------------------------------

function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  const directory = Buffer.alloc(16 * entries.length)
  let offset = 6 + directory.length
  entries.forEach((entry, i) => {
    const base = i * 16
    directory[base] = entry.size >= 256 ? 0 : entry.size
    directory[base + 1] = entry.size >= 256 ? 0 : entry.size
    directory[base + 2] = 0 // palette size
    directory[base + 3] = 0 // reserved
    directory.writeUInt16LE(1, base + 4) // colour planes
    directory.writeUInt16LE(32, base + 6) // bits per pixel
    directory.writeUInt32LE(entry.data.length, base + 8)
    directory.writeUInt32LE(offset, base + 12)
    offset += entry.data.length
  })
  return Buffer.concat([header, directory, ...entries.map((e) => e.data)])
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const svg = readFileSync(SVG_PATH, 'utf8')
  const vb = /viewBox="([^"]+)"/.exec(svg)?.[1]
  if (!vb) throw new Error('logo.svg has no viewBox')
  const viewBox = vb.trim().split(/\s+/).map(Number)
  const paths = readPaths(svg)
  if (paths.length === 0) throw new Error('logo.svg has no <path> elements')

  mkdirSync(OUT_DIR, { recursive: true })

  const png = (size) => encodePng(render(paths, size, size, viewBox), size, size)

  writeFileSync(path.join(OUT_DIR, 'icon.png'), png(512))
  writeFileSync(path.join(OUT_DIR, 'tray.png'), png(16))
  writeFileSync(path.join(OUT_DIR, 'tray@2x.png'), png(32))

  const icoSizes = [16, 24, 32, 48, 64, 128, 256]
  const ico = encodeIco(icoSizes.map((size) => ({ size, data: png(size) })))
  writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico)

  const written = ['icon.png', 'icon.ico', 'tray.png', 'tray@2x.png']
  for (const name of written) {
    const bytes = readFileSync(path.join(OUT_DIR, name)).length
    console.log(`assets/${name} — ${bytes} bytes`)
  }
}

main()
