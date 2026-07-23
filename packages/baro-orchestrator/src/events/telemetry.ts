/** Model invocation measurements. Wire `type` strings are frozen (see ../semantic-events.ts). */

import { defineSemanticEvent } from "./define.js"
import type { ModelInvocationMeasuredData } from "../model-telemetry.js"

/** Backend-neutral, replay-safe usage/cost observation for one model call. */
export const ModelInvocationMeasured =
    defineSemanticEvent<ModelInvocationMeasuredData>("model_invocation_measured")
