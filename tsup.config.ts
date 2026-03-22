import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/client.ts', 'src/proxy.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  outDir: 'dist',
  platform: 'node',
  external: [],
  banner: {
    // ESM bundles don't have `require` — add createRequire shim so
    // CJS dependencies (like @modelcontextprotocol/sdk's spawn usage) work
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
})
