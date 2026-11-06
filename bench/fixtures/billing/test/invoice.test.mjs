import { test } from "node:test"
import assert from "node:assert/strict"
import { invoiceTotal } from "../lib/invoice.mjs"

test("sums whole prices", () => {
    assert.equal(invoiceTotal([{ price: 10, quantity: 2 }]), "20.00 EUR")
})

test("keeps cents that floating point loses", () => {
    assert.equal(invoiceTotal([{ price: 0.29, quantity: 1 }, { price: 1.15, quantity: 3 }]), "3.74 EUR")
})
