declare module 'b4a' {
  export function toString(data: Uint8Array): string
}
declare module '*.bundle.js' {
  const bundle: string
  export default bundle
}
