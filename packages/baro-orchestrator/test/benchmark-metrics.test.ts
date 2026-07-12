import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    meanComplete,
    metricCoverageLabel,
    runtimeReplanAuditKey,
    summarizeReplanEvents,
    totalCompleteMetrics,
} from "../src/benchmark-metrics.js"
import {
    knownMetric,
    notApplicableMetric,
    unknownMetric,
} from "../src/model-telemetry.js"

describe("benchmark metrics", () => {
    it("keeps a known zero while refusing an unknown aggregate", () => {
        const zero = totalCompleteMetrics([knownMetric(0, "cli_result")])
        assert.equal(zero.value, 0)
        assert.equal(metricCoverageLabel(zero), "1/1")

        const partial = totalCompleteMetrics([
            knownMetric(2, "cli_result"),
            unknownMetric("not_reported"),
        ])
        assert.equal(partial.value, null)
        assert.equal(metricCoverageLabel(partial), "1/2")
    })

    it("does not call not-applicable a zero-dollar measurement", () => {
        const total = totalCompleteMetrics([notApplicableMetric()])
        assert.equal(total.value, null)
        assert.equal(total.notApplicable, 1)
    })

    it("returns an unknown mean when any trial is unmetered", () => {
        assert.equal(meanComplete([0, 2]), 1)
        assert.equal(meanComplete([0, null]), null)
        assert.equal(meanComplete([]), null)
    })

    it("counts committed runtime replans without counting their TUI projection", () => {
        assert.deepEqual(
            summarizeReplanEvents({
                replan: 2,
                runtime_replan_proposed: 4,
                runtime_replan_applied: 3,
                runtime_replan_rejected: 1,
                // stdout protocol events are intentionally not part of this
                // audit-count input, so the three projections add no total.
                tui_replan_projection: 3,
            }),
            {
                legacyEvents: 2,
                runtimeProposed: 4,
                runtimeApplied: 3,
                runtimeRejected: 1,
                total: 5,
            },
        )
    })

    it("normalizes absent or invalid audit counters to zero", () => {
        assert.deepEqual(summarizeReplanEvents({ replan: -1 }), {
            legacyEvents: 0,
            runtimeProposed: 0,
            runtimeApplied: 0,
            runtimeRejected: 0,
            total: 0,
        })
    })

    it("deduplicates Applied delivery identity by run, proposal, and commit version", () => {
        const payload = {
            runId: "run-1",
            proposalId: "proposal-1",
            graphVersion: 2,
            currentGraphVersion: 3,
        }
        assert.equal(
            runtimeReplanAuditKey("runtime_replan_applied", payload),
            runtimeReplanAuditKey("runtime_replan_applied", {
                ...payload,
                currentGraphVersion: 9,
            }),
        )
        assert.notEqual(
            runtimeReplanAuditKey("runtime_replan_applied", payload),
            runtimeReplanAuditKey("runtime_replan_applied", {
                ...payload,
                graphVersion: 3,
            }),
        )
        assert.equal(
            runtimeReplanAuditKey("runtime_replan_applied", {
                ...payload,
                graphVersion: "2",
            }),
            null,
        )
    })
})
