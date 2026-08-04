# Phase boundaries: why the Architect is not moved onto the run's bus

**Status:** Accepted (2026-08-04)

## Context

Baro's roles are mozaik participants: story agents, critic, surgeon, merge
gate, goal guardian, supervisor, dialogue — and, since 0.83/0.84, the planner
and the Architect with its scouts. That made "everything is a participant"
sound like a target, and the Architect the last holdout: it was the only role
that spoke without listening, and in one day of live runs it stated three
things the repository contradicts (a test command that runs zero tests, an
import that fails under jest, an enum member that does not exist), each caught
by a story agent hours later while the contract kept asserting it.

The obvious conclusion was to move the Architect phase into `orchestrate()` so
it lives on the run's environment for the whole run. Investigating what that
would take changed the conclusion.

## What the system actually looks like

Four processes, each with its own environment, spawned in sequence by the Rust
front end:

| phase | process | environment |
|---|---|---|
| conversation (goal envelope) | `run-conversation` | `conversation-frontdoor:<session>:<request>` — **per turn** |
| intake (execution shape) | `run-intake` | none; a bounded call |
| architect + scouts | `run-architect` | `architect-bus` |
| execution | `orchestrate` | the run's environment |

The boundaries are process boundaries, not just environment boundaries. And
the Architect is not merely a phase before planning: it is the goal-envelope
validator, invoked from the conversation flow, and it can return `NeedsInput`,
which becomes a clarification question to the **user**.

## Decision

Keep the phase boundary. The Architect stays a bounded-lifetime participant in
its own phase and its own process; it does not join the run's environment.

Three reasons, in order of weight:

1. **A contract that can be renegotiated while it is enforced is not a
   contract.** The ADR is a fixed point precisely so that parallel agents
   agree with a document rather than with each other. An Architect alive on
   the run's bus stops being the arbiter and becomes another voice.
2. **Its interlocutor is upstream.** It talks to the user (clarifications) and
   to the repository (scouts). On the run's bus sit the agents executing its
   decision, and to them it has nothing left to say that the contract has not
   already said.
3. **Process isolation is load-bearing.** One bus means one process: an
   Architect crash would take the run with it, and vice versa. That is a real
   cost against a modest win.

"Every role must be a participant for the whole run" is aesthetics, not a
mozaik principle. Mozaik says participants react to events; scouts live only
during research, the conversation only at the front door. A participant with a
bounded lifetime is still a participant.

## Consequences

- Research findings persist in `architect-*.log` rather than the run's audit
  jsonl. Two files, not a lost record.
- ADRs arrive whole rather than as fragments, so planning waits for the phase
  (~8–15 min on large goals).
- The premise problem that motivated the move is solved without it: a story
  that proves a factual claim false files an evidence-backed dispute and the
  **host** amends the decision document. The decision stays frozen; only the
  claim is withdrawn, and the host — not a model that changed its mind — holds
  the pen.

## Revisit when

- A run fails because a **decision** (not a premise) was wrong and could not be
  changed, or
- the Architect funnel becomes the dominant wall-clock cost and incremental ADR
  admission would measurably pay for itself.

Until one of those is measured, the move is cost without payment.
