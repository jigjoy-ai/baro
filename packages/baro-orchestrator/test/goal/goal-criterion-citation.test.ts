import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { normalizeText, resolveCitedCriteria } from "../../src/goal/goal-criterion-citation.js"

const ids = ["G-A1", "G-A2", "G-C4"]
const criteria = [
    "[G-A1] src/title-case.js postoji i izvozi funkciju titleCase(text) sa dokumentovanim ponašanjem za rubne slučajeve",
    "[G-A2] Izlaz npm test pokazuje da svih šest novih testova prolazi (i da postojeći testovi i dalje prolaze)",
    "[G-C4] truncate mora dodati elipsu samo kada je tekst zaista skraćen, koristeći dosledno jedan stil elipse ('…' ili '...')",
]

describe("resolveCitedCriteria", () => {
    it("keeps exact strings and accepts the bare tag", () => {
        assert.deepEqual(resolveCitedCriteria([criteria[1]!], criteria, ids), [criteria[1]])
        assert.deepEqual(resolveCitedCriteria(["[G-A2]", "G-C4", " [G-A1] "], criteria, ids), [criteria[1], criteria[2], criteria[0]])
    })

    it("accepts the text with typographic drift a model introduces", () => {
        const drifted = "[G-C4] truncate mora dodati elipsu samo kada je tekst zaista skraćen, koristeći  dosledno jedan stil elipse (‘...’ ili ‘...’)."
        assert.deepEqual(resolveCitedCriteria([drifted], criteria, ids), [criteria[2]])
        const untagged = "Izlaz npm test pokazuje da svih šest novih testova prolazi (i da postojeći testovi i dalje prolaze)"
        assert.deepEqual(resolveCitedCriteria([untagged], criteria, ids), [criteria[1]])
        const numbered = "2. [G-A2] Izlaz npm test pokazuje da svih šest novih testova prolazi (i da postojeći testovi i dalje prolaze)"
        assert.deepEqual(resolveCitedCriteria([numbered], criteria, ids), [criteria[1]])
    })

    it("refuses paraphrase, a tag contradicting its text, and unknown tags", () => {
        assert.equal(resolveCitedCriteria(["npm test shows all six new tests passing"], criteria, ids), null)
        assert.equal(resolveCitedCriteria([`[G-A1] ${criteria[1]!.slice(7)}`], criteria, ids), null)
        assert.equal(resolveCitedCriteria(["[G-Z9]"], criteria, ids), null)
        // Diacritics are meaning, not typography: a stripped "c" is another word.
        assert.equal(resolveCitedCriteria(["Izlaz npm test pokazuje da svih sest novih testova prolazi (i da postojeci testovi i dalje prolaze)"], criteria, ids), null)
    })

    it("does not collapse two distinct criteria that normalise alike", () => {
        const twins = ["[G-X1] Run the tests.", "[G-X2] Run the tests"]
        assert.equal(resolveCitedCriteria(["Run the tests"], twins, ["G-X1", "G-X2"]), null)
        assert.deepEqual(resolveCitedCriteria(["[G-X2]"], twins, ["G-X1", "G-X2"]), [twins[1]])
    })

    it("normalizeText folds quotes, ellipsis, dashes, whitespace and trailing punctuation only", () => {
        assert.equal(normalizeText("  Foo — “bar”…  "), 'foo - "bar"...')
        assert.equal(normalizeText("3. Čekaj,  molim te."), "čekaj, molim te")
    })
})
