import { resolve } from 'node:path'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const src = (p: string): string => resolve(__dirname, 'src', p)

/**
 * Electron loads the renderer from a `file://` URL.
 *
 * Vite marks the entry module and its stylesheet with `crossorigin`, which
 * makes the browser fetch them in CORS mode. Chromium refuses cross-origin
 * requests from a `file://` origin, so the module is aborted with
 * `ERR_ABORTED` and the packaged window stays blank — the app runs, but the
 * interface never appears.
 *
 * Dropping the attribute lets both load as ordinary same-origin files.
 */
function stripCrossorigin(): Plugin {
  return {
    name: 'mysort:strip-crossorigin',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html: string) {
        return html.replace(/\s+crossorigin(=(""|'[^']*'))?/g, '')
      },
    },
  }
}

function devCsp() {
  return {
    name: 'mysort:dev-csp',
    apply: 'serve' as const,
    transformIndexHtml(html: string): string {
      return html.replace(
        /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/,
        `$1default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: http:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'$3`
      )
    },
  }
}

export default defineConfig({
  main: {
    plugins: [
      {
        name: 'mysort:copy-assets',
        buildStart() {
          // Copy runtime assets (tray icon, window icon) into the output so
          // the main process can load them in both dev and production.
          const assetsDir = resolve(__dirname, 'assets')
          const outDir = resolve(__dirname, 'out', 'main', 'assets')
          mkdirSync(outDir, { recursive: true })
          for (const name of ['icon.png', 'tray.png', 'tray@2x.png']) {
            const src = resolve(assetsDir, name)
            if (existsSync(src)) {
              copyFileSync(src, resolve(outDir, name))
            }
          }
        },
      },
    ],
    build: {
      rollupOptions: {
        input: src('main/index.ts'),
        external: ['electron'],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: src('preload/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.js' },
        external: ['electron'],
      },
    },
  },
  renderer: {
    // The renderer is loaded from disk in production, so every asset URL has
    // to be relative to the HTML file.
    base: './',
    plugins: [react(), devCsp(), stripCrossorigin()],
    build: {
      rollupOptions: {
        input: src('renderer/index.html'),
      },
    },
  },
})
