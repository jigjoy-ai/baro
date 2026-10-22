import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { loadEmbeddingPipeline } from '../vectra-store.js'

// Vector recorded with @xenova/transformers 2.17.2. A drift here means the
// embedding model changed under existing indexes and similarity thresholds.
const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/minilm-q8-xenova-2.17.2.json', import.meta.url), 'utf-8'),
) as { text: string; vector: number[] }

describe('embedding parity with the 2.x stack', () => {
    it('produces the same MiniLM vector', async () => {
        const extractor = await loadEmbeddingPipeline('Xenova/all-MiniLM-L6-v2')
        const vector = Array.from((await extractor(fixture.text, { pooling: 'mean', normalize: true })).data)

        expect(vector).toHaveLength(384)
        const cosine = vector.reduce((sum, x, i) => sum + x * fixture.vector[i], 0)
        // fp32 weights land near 0.993; the q8 weights match to ~1e-6.
        expect(cosine).toBeGreaterThan(0.999)
    }, 60000)
})
