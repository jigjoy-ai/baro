import { test } from "node:test"
import assert from "node:assert/strict"
import { receiptLine } from "../lib/receipt.mjs"

test("formats a payment", () => {
    assert.equal(receiptLine("Coffee", 2.5), "Coffee: 2.50 EUR")
})

test("formats a refund as a negative amount", () => {
    assert.equal(receiptLine("Refund", -3.05), "Refund: -3.05 EUR")
})
