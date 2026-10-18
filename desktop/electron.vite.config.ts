import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const src = (p: string): string => resolve(__dirname, 'src', p)

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
    plugins: [react(), devCsp()],
    build: {
      rollupOptions: {
        input: src('renderer/index.html'),
      },
    },
  },
})
