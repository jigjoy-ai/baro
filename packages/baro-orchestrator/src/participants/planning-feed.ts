/**
 * Private host-process bridge for progressive planning.
 *
 * The feed has no graph authority of its own: it only translates the Rust
 * host's correlated stdin commands into immutable Mozaik events. The exact
 * PlanningFeed object is bound as an authority on CollectiveBoard, which owns
 * validation, persistence and scheduling.
 */

import { BaseObserver, type SemanticEvent } from "../runtime/mozaik.js"

import {
    PlanFragmentProposed,
    PlanningStreamCompleted,
    PlanningStreamFailed,
    PlanningStreamOpened,
} from "../semantic-events.js"
import type {
    PlanCompleteCommand,
    PlanFailedCommand,
    PlanFragmentCommand,
    PlanningFeed as PlanningFeedContract,
    PlanningOpenCommand,
} from "../stdin-commands.js"

export class PlanningFeed
    extends BaseObserver
    implements PlanningFeedContract
{
    open(command: PlanningOpenCommand): void {
        this.publish(
            PlanningStreamOpened.create({
                runId: command.run_id,
                planningId: command.planning_id,
            }),
        )
    }

    fragment(command: PlanFragmentCommand): void {
        this.publish(
            PlanFragmentProposed.create({
                runId: command.run_id,
                planningId: command.planning_id,
                fragmentId: command.fragment_id,
                ordinal: command.ordinal,
                // The external lane is intentionally unknown. The Board's
                // strict validator is the authority boundary.
                stories: command.stories,
            }),
        )
    }

    complete(command: PlanCompleteCommand): void {
        this.publish(
            PlanningStreamCompleted.create({
                runId: command.run_id,
                planningId: command.planning_id,
                finalPrd: command.final_prd,
            }),
        )
    }

    failed(command: PlanFailedCommand): void {
        this.publish(
            PlanningStreamFailed.create({
                runId: command.run_id,
                planningId: command.planning_id,
                code: command.code,
                reason: command.reason,
            }),
        )
    }

    private publish(event: SemanticEvent<unknown>): void {
        for (const environment of this.getEnvironments()) {
            environment.deliverSemanticEvent(this, event)
        }
    }
}
