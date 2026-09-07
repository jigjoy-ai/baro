import { defineConfig } from 'tsup'

/* The browser bundle. dsh's shell seeds React, Cordis and a few client
   libraries into a shared module table; every dynamic bundle resolves those
   as externals and carries everything else privately. Mirrors what their
   in-tree `clientBundle` helper does for shipped plugins. */
export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  outDir: 'dist',
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  splitting: false,
  sourcemap: true,
  clean: false,
  dts: false,
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
})
