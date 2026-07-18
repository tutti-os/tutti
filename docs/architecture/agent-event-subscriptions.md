# Agent Event Subscriptions

Agent event subscriptions are the durable, provider-neutral mechanism for
resuming one Agent session when a fact produced by another Agent becomes true.
They belong to `packages/agent/host` and the canonical SQLite store; CLI and
future app adapters only create subscriptions or contribute source facts.

This is orchestration, not the business WebSocket event stream. A disconnected
desktop must not lose a continuation. WebSocket observers may later project
subscription and delivery state, but they are never the delivery authority.

## Contract

The version 1 public catalog is Agent-turn-only, closed, and enumerable:

- `agent.turn.completed`
- `agent.turn.failed`
- `agent.turn.canceled`
- `agent.turn.interrupted`

Each definition has a stable type, version, source kind, outcome mapping, and
one-shot policy. The mapping lives once in `store-sqlite/canonical`; Host uses
it for enumeration and the transaction participant uses it for matching.
Subscriptions identify the workspace, subscriber session, event type, source
session, and optionally an exact source turn. A caller-owned subscription ID
makes creation replay-safe. Self-subscription is rejected, and all referenced
sessions and optional turns must already exist in the same workspace.

Version 1 subscriptions are one-shot. The first matching terminal turn changes
the subscription from `active` to `matched`; cancel changes an active
subscription to `canceled`. A matched subscription cannot trigger again.

The delivered payload uses a CloudEvents-inspired shape without claiming full
CloudEvents wire compatibility:

```json
{
  "id": "canonical-mutation-id",
  "type": "agent.turn.completed",
  "version": 1,
  "source": {
    "kind": "agent_turn",
    "id": "source-session",
    "subjectId": "source-turn",
    "agentSessionId": "source-session",
    "turnId": "source-turn"
  },
  "data": {},
  "directive": "continue_waiting_task",
  "subscriptionId": "subscription-id",
  "deliveryId": "delivery-id"
}
```

The stable `id`, `type`, version, and source identity follow the useful core of
the [CloudEvents event context](https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md).

## Durable Flow

1. An Agent calls `agent subscriptions create`; inside Agent context,
   `session-id` defaults to the calling session.
2. The canonical turn state machine accepts a terminal transition.
3. `EventSubscriptionParticipant` matches subscriptions and appends prepared
   deliveries in the same SQLite transaction as that terminal fact.
4. The Host delivery worker leases each prepared item and calls `Host.SendInput`
   for the subscriber.
5. The continuation uses `event-delivery:<delivery-id>` as its typed
   `ClientSubmitID`. If the process loses the lease after runtime acceptance,
   retry resolves the existing submit claim instead of executing twice.
6. Only after `SendInput` succeeds does the worker mark the delivery completed.
   The structured event is submitted as a normal turn with typed
   `event_continuation` submission metadata. That domain kind suppresses
   initial-title derivation; it is not active-turn guidance.

Leases are requeued at startup. Delivery is at-least-once and retries without a
fixed attempt ceiling, using exponential backoff capped at 256 seconds. The
deterministic submit ID turns that transport-level at-least-once behavior into
one logical continuation turn. This follows the same consumer-idempotency
requirement documented by [Dapr pub/sub](https://docs.dapr.io/developing-applications/building-blocks/pubsub/pubsub-overview/).

Deleting a source session cancels its still-active Agent-turn subscriptions but
does not erase a delivery already prepared from a terminal fact. Deleting the
subscriber cancels its active subscriptions and marks unfinished deliveries
failed with a stable machine error, preventing permanent retry poison. Hard
purge can then cascade subscriber-owned records safely.

Recovery order is runtime operations, goal operations, goal inbox, event
deliveries, stale-turn settlement, then worktree garbage collection. Stale-turn
settlement itself is a canonical terminal mutation, so an interrupted event
created during that step remains durable and is delivered by the periodic
worker after recovery.

## Industry Decisions

- Temporal models workflows as stateful services receiving asynchronous
  Signals or tracked Updates. Tutti similarly persists the message before
  execution, but maps it to a normal Agent turn so provider adapters need no
  special resume protocol. See [Temporal workflow message passing](https://docs.temporal.io/encyclopedia/workflow-message-passing).
- GitHub Actions `workflow_run` demonstrates an enumerable completion trigger
  with conclusion filtering, along with explicit recursion and privilege
  concerns. Tutti starts with exact source-session/outcome filters, one-shot
  subscriptions, and no privilege escalation. See [GitHub Actions workflow
  run events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run).
- Codex and Claude subagents coordinate through parent-owned orchestration. The
  Tutti contract generalizes the useful wait-and-resume behavior across
  independent sessions instead of embedding it in one provider. See [Codex
  subagents](https://developers.openai.com/codex/subagents) and [Claude Code
  subagents](https://docs.anthropic.com/en/docs/claude-code/sub-agents).

## CLI Surface

```text
tutti agent event-types --json
tutti agent subscriptions create --workspace-id <workspace> \
  --event-type agent.turn.completed \
  --source-session-id <source> \
  [--source-turn-id <turn>] [--session-id <subscriber>] \
  [--subscription-id <id>] --json
tutti agent subscriptions list --workspace-id <workspace> \
  [--session-id <subscriber>] --json
tutti agent subscriptions cancel --workspace-id <workspace> \
  --subscription-id <id> [--session-id <subscriber>] --json
```

## Extension Direction

The durable tables already store generic `source_kind`, `source_id`,
`source_subject_id`, event version, and payload JSON. Version 1 only exposes an
Agent-turn creator and matcher. App events are intentionally not accepted as
arbitrary strings. A future app
source must register a versioned catalog fragment with a namespaced source kind
and validate its specialized payload before appending a canonical event fact.
That source can reuse the subscription/delivery state machine without migrating
its source identity shape. Its taxonomy and observable projection still belong
to `packages/events/protocol`; it must not bypass the durable transaction
participant with an in-memory callback.

Recurring subscriptions, wildcard types, remote/cloud brokers, UI management,
and cross-workspace delivery are outside version 1. Add them only with explicit
loop limits, authorization rules, and delivery observability.
