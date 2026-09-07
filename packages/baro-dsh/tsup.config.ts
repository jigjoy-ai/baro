import { defineConfig } from 'tsup'

/* The browser bundle. dsh concatenates every plugin's client bundle into one
   script, so a bundle is not a module: it is a CommonJS body wrapped in a
   `window.__ModuleLoader__.load({ id, factory(require) })` registration, and
   the shell's shared module table answers `require` for React, Cordis and a
   few client libraries. Everything else is carried privately. Mirrors what
   their in-tree `clientBundle` helper emits for shipped plugins. */
const ID = 'baro-dsh'

export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  tsconfig: 'tsconfig.client.json',
  esbuildOptions(options) {
    options.jsx = 'automatic'
  },
  outDir: 'dist',
  format: ['cjs'],
  outExtension: () => ({ js: '.js' }),
  platform: 'browser',
  target: 'es2022',
  splitting: false,
  sourcemap: true,
  clean: false,
  dts: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
  banner: {
    js: [
      `window.__ModuleLoader__.load({`,
      `  id: ${JSON.stringify(ID)},`,
      `  factory: (require) => {`,
      `    var module = { exports: {} };`,
      `    var exports = module.exports;`,
    ].join('\n'),
  },
  footer: {
    js: ['    return module.exports;', '  }', '});'].join('\n'),
  },
})
