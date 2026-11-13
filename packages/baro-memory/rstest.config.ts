import { defineConfig } from '@rstest/core'

export default defineConfig({
    testEnvironment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    // The first run downloads the ONNX embedding model.
    testTimeout: 60_000,
})
