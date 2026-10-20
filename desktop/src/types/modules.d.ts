declare module '*.sql?raw' {
  const content: string
  export default content
}

declare module '*.module.css' {
  const classes: { readonly [key: string]: string }
  export default classes
}

declare module '*.css' {
  const css: string
  export default css
}

/** Static assets imported by the renderer resolve to a URL. */
declare module '*.svg' {
  const src: string
  export default src
}
