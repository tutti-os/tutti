# Tutti Mode Activation And Workspace Workflows

This document describes the Tutti-owned activation and workflow models used by
Tutti Mode Plan. It covers the daemon business core, the Agent CLI boundary,
AgentGUI projection, and Issue materialization.

## Ownership Boundary

Tutti Mode is a Tutti-owned host preference, not a provider-native Agent mode
or a capability granted to the Agent. Agent sessions and turns provide
association, isolation, and provenance, but they do not own the Tutti
activation, proposal, user decision, or resulting Issue. Tutti CLI
availability is a separate runtime capability and never derives from the
activation badge.

Ownership is split as follows:

- `services/tuttid/biz/tuttimodeactivation` defines the durable activation and
  immutable revision vocabulary.
- `services/tuttid/service/tuttimodeactivation` owns activation transitions,
  submission snapshots, and post-commit publication.
- `services/tuttid/biz/workspaceworkflow` defines the durable workflow entities
  and state vocabulary.
- `services/tuttid/service/tuttimodeplan` validates Markdown revisions,
  enforces transitions, projects executable work, and coordinates downstream
  operations.
- `services/tuttid/biz/tuttimodeexecution` defines the durable Tutti execution
  aggregate and checkpoint vocabulary.
- `services/tuttid/service/tuttimodeexecution` owns Tutti execution
  materialization and later orchestration commands.
- `services/tuttid/data/workspace` stores workflow metadata in SQLite. Plan
  content is kept in immutable files under the Tutti state directory.
- `services/tuttid/service/cli/providers/tuttimodeplan` exposes Agent-callable
  propose, revise, and get commands. It deliberately exposes no decision
  command and no wait/poll command: the agent's turn ends after propose or
  revise, and the user's review decision reaches the agent as a new user
  message.
- `packages/agent/gui/workspaceWorkflow` renders the daemon snapshot and sends
  user decisions through the desktop runtime adapter. It contains no workflow
  business state machine.
- Workspace Issue Manager owns the Issue and task graph after an accepted
  task-graph revision is materialized.

Provider-native Plan mode remains independent. `/plan` may enable a provider's
planning behavior, while `/tutti` creates or advances a Tutti-owned
`TuttiModeActivation`. The badges are compatible, and removing either badge
only disables that modifier. The Tutti badge creates durable activation state,
not a workflow; a workflow begins only when the Agent invokes the Tutti CLI.
Workflow CLI capabilities remain discoverable when activation is inactive, but
their mutation paths require the user-controlled activation to be active. The
Agent has no CLI or service mutation that can change this state; it must ask the
user to turn Tutti Mode on manually. The persisted `agent_command` source is
retained only so revisions written by older builds remain readable.

## Durable And Derived Entities

| Entity                      | Persistence                                  | Purpose and relations                                                                                                                                                                                                                  |
| --------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TuttiModeActivation`       | SQLite                                       | Tutti-owned session-associated activation root. It points to the current immutable activation revision; Agent Session exposes only an independent read projection.                                                                     |
| `ActivationRevision`        | SQLite                                       | Append-only active or inactive transition. A submitted Turn uses one exact revision so later badge changes cannot rewrite running or historical work.                                                                                  |
| `WorkspaceAgentSubmitClaim` | SQLite                                       | Generic idempotency record from `clientSubmitId` to one preallocated canonical Turn ID. A prepared claim is retained when delivery is ambiguous, so a retry reconciles or reports unknown instead of dispatching again.                |
| `TuttiModeTurnSnapshot`     | SQLite                                       | First-write-wins link from one canonical Turn to the exact activation revision observed before provider dispatch. Same-Turn guidance reuses it instead of reading current state.                                                       |
| `WorkspaceWorkflow`         | SQLite                                       | Tutti-owned lifecycle root. It belongs to one workspace, records its source Agent session and any trusted turn/tool-call provenance available at creation, and points to the current revision.                                         |
| `TuttiModePlan`             | SQLite                                       | Type-specific one-to-one marker for a `WorkspaceWorkflow`. It does not contain plan text.                                                                                                                                              |
| `PlanRevision`              | SQLite metadata plus immutable Markdown file | Append-only version of the proposal. Metadata records sequence, schema, path, SHA-256, and producing turn.                                                                                                                             |
| `WorkflowCheckpoint`        | SQLite                                       | A user-owned decision gate bound to exactly one revision. The task review is the only active checkpoint kind; the configuration-review kind survives solely as legacy vocabulary on retired workflows.                                 |
| `WorkflowTurnLink`          | SQLite                                       | Optional provenance link from a workflow to source, decomposition, revision, or feedback turns.                                                                                                                                        |
| `WorkflowOperation`         | SQLite                                       | Idempotent record of a downstream side effect such as generating a task graph, creating a revision, or creating an Issue. A successful Issue operation stores the Issue ID.                                                            |
| `WorkflowMutation`          | SQLite                                       | Durable caller mutation ledger for propose/revise response-loss recovery. Its scoped request ID is the identity; the input SHA-256 detects conflicting reuse, and the row points to the committed workflow/revision/checkpoint result. |
| `ActionableItem`            | Derived only                                 | Read-only projection of a task from the accepted current task-graph revision. It is never a second task store.                                                                                                                         |
| Workspace Issue and Task    | SQLite in Issue Manager                      | Reusable Issue graph materialized from accepted `ActionableItem`s. It links back through `sourceSessionId`; the workflow operation links forward through `issueId`.                                                                    |
| Tutti execution             | SQLite                                       | Tutti-owned orchestration authority for one accepted workflow and Issue. Initial status is `awaiting_schedule` at graph revision 1.                                                                                                    |
| Execution checkpoint        | SQLite                                       | Ordered durable orchestration gate. Materialization creates one active `initial_schedule` checkpoint and no Issue Run; every terminal Run later appends one deterministic settlement checkpoint.                                       |
| Execution mutation          | SQLite                                       | Source-session-scoped mutation ledger for exact checkpoint/revision graph changes. It provides replay/conflict detection and records the incremented graph revision.                                                                   |

The relation is:

```text
clientSubmitId --- WorkspaceAgentSubmitClaim --- canonical Agent Turn
                                                     |
                                                     v
Agent Session 1 ----- 0..1 TuttiModeActivation
                              |
                              +--- * ActivationRevision
                              |          |
                              |          +--- * TuttiModeTurnSnapshot ---+

Agent Session / Turn / Tool Call (workflow provenance)
                  |
                  v
         WorkspaceWorkflow 1 --- 1 TuttiModePlan
                  |
                  +--- * PlanRevision --- 1 immutable Markdown file
                  |          |
                  |          +--- * WorkflowCheckpoint
                  |
                  +--- * WorkflowTurnLink --- Agent Turn
                  |
                  +--- * WorkflowOperation --- 0..1 Workspace Issue
                  |
                  +--- * WorkflowMutation --- committed revision/checkpoint result
                                  ^
                                  |
          accepted current task-graph revision
                  -> ActionableItem projection
                  -> Workspace Issue + Tasks
                  -> Tutti execution + initial_schedule checkpoint
```

`ActionableItem` exists only when the current revision is a `task_graph`, its
bound checkpoint is accepted, and that revision is still current. Pending,
rejected, superseded, and stale revisions project no executable work.

`TuttiModeActivation` and `WorkspaceWorkflow` are independent roots. Activating
the badge does not create a workflow, and invoking the CLI without an active
badge may still create a workflow. A workflow reaches an activation revision
only indirectly through its source Turn provenance; it never changes the
badge.

The Agent CLI runtime context supplies `AgentSessionID` as the workflow
association and isolation key. `plan revise` and `plan get`
require the same caller session as the workflow's `sourceSessionId`; a mismatch
is deliberately reported as not found. This is a local capability boundary,
not a claim that an environment variable is a malicious-client authentication
credential. The daemon host is responsible for constructing the CLI runtime
context. Until it exposes a trusted current Turn/tool-call seam, CLI proposal
creation leaves `sourceTurnId` and `sourceToolCallId` empty. In particular,
App CLI `ParentCommandID` is nested-command context and must never be recorded
as an Agent tool-call ID.

The same caller authority applies after Issue materialization. Generic Issue
Manager mutations cannot modify a `tutti_mode_plan` graph; they return
`tutti_issue_managed` with `recommendedAction = open_source_session`. The
source Agent uses `tutti plan issue mutate` and supplies the active execution
checkpoint and expected graph revision. Admission validates all operations and
the resulting dependency graph in one SQLite transaction, advances the graph
revision, rebinds the checkpoint, and cancels stale prepared/dispatched Goal
Review state and reviewer wakes. Logical supersession preserves obsolete
task/Run/output history while removing that task from the active projection;
running tasks must settle before they can be superseded.

## Activation And Turn Snapshot Flow

Before a Session exists, AgentGUI keeps the `/tutti` choice as an engine-owned
pending activation intent. Session creation carries that intent explicitly;
the daemon persists the Activation before starting the initial submission and
returns the independent read projection. Existing-session badge changes use a
revision-checked, idempotent activation command.

For every initial submission or ordinary Turn, the daemon allocates the
canonical Turn ID before provider dispatch. When a `clientSubmitId` is present,
the generic submit claim durably reserves that exact ID first. The daemon then
persists a `TuttiModeTurnSnapshot` under the same ID before calling the runtime.
A persistence failure therefore cannot start provider work. The runtime must
accept and return that exact ID; it may not replace it with a runtime-generated
one. Same-Turn guidance reads the already-bound snapshot instead of observing
the current badge. A missing snapshot for an existing Turn fails closed rather
than being reinterpreted as inactive. Removing the badge appends an inactive
revision: it cannot alter an in-flight Turn, while the next new Turn receives
the inactive snapshot. An explicit inactive revision retains its activation
identity; a Session that has never been activated uses the canonical
unconfigured inactive snapshot.

Runtime acceptance has three explicit outcomes. A definite pre-dispatch
rejection abandons the prepared snapshot and submit claim. The API maps
`clientSubmitId` into typed create/send input, and the service passes it through
typed runtime input instead of recovering it from diagnostics metadata. After
`Exec` reports provider acceptance, the Agent service explicitly invokes the
required `RuntimeController.DurablyReportSubmitProvenance` method before any
snapshot or claim promotion. The runtime adapter only maps and delegates this
typed call. Because it occurs after `Exec` releases the Session lifecycle lock,
the controller can wait on an uncoalesced FIFO durability barrier: the ordinary
submitted report must already have created the canonical Turn, then one SQLite
transaction writes the enriched Session projection and stable `clientSubmitId`
user message against that exact Turn. After the barrier succeeds, the service
accepts the bound snapshot, then reads the exact message provenance back before
accepting the submit claim; retry reconciliation repeats both promotions
idempotently. A
barrier failure, or an accepted response with a different Turn ID, retains the
claim, Session, activation, and snapshot.
A retry with the same `clientSubmitId` first reconciles the preallocated Turn
only against durable per-submit provenance and never performs a second
provider dispatch while delivery remains unknown. A live runtime Turn, an
accepted activation snapshot, or a matching Turn ID without that submit
provenance is not enough evidence—especially because multiple guidance
submissions may target the same Turn. This is an intentional at-most-once
safety boundary; ambiguity is surfaced rather than guessed away. A crash after
claim reservation but before the barrier commits leaves a prepared—not
accepted—claim conservatively unknown. A crash after the barrier commits is
deterministically reconciled from the stable message without another provider
dispatch. Same-Turn guidance uses one distinct message per `clientSubmitId`, so
multiple guidance submissions remain independently recoverable without
rewriting the active Turn lifecycle.

The runtime derives a canonical Tutti-owned Host Context only from that exact
snapshot. It does not derive instructions from `capabilityRefs`, user Prompt
text, transcript markers, or arbitrary metadata. Provider adapters use the
strongest host seam they expose. Codex uses developer instructions when its
collaboration-mode contract is available; Codex without that negotiated seam
and standard ACP use a provider-transport-only synthetic prompt block; Claude
uses a coordinator-owned synthetic message. These fallbacks are transport
details, not user-authored messages: Tutti's visible user message, prompt
preview, and activity transcript remain unchanged. The context explicitly
distinguishes Tutti activation from provider Default/Plan mode and reasoning
effort. Reusing an existing provider Session does not weaken that boundary:
each new Turn receives the current immutable activation snapshot before
dispatch. The snapshot's `state` is the sole authority for reporting Tutti Mode
status; provider Default/Plan mode and workflow existence are independent facts
that cannot override it. A clear plan request still enters the Tutti proposal
workflow instead of returning a chat-only plan. An active snapshot is a
directive, not a suggestion: the Agent must
not execute the user's request directly in that turn. It first asks focused
clarifying questions when the request is ambiguous or missing key
constraints, then submits one complete tutti-mode-plan/v1 document through a
single run of the `tutti plan propose` shell command and then ends the turn
immediately — there is no wait command, and the user's review decision
always arrives as a new user message. Because providers repeatedly misread
the bare directive as a built-in tool they lack and fall back to provider
planning surfaces (`update_plan`, TodoWrite, chat-only Markdown plans), the
active context also carries one worked example per workflow step: the
resolved CLI executable name (`tutti-dev` on development installs), the
exact `plan propose` / `plan revise` command lines, and a minimal
valid plan document showing the frontmatter task graph. The guide requires a
complete launch configuration on every task — `agentTargetId`, `model`, and
`permissionModeId` copied from `agent composer-options` output, never
invented — plus explicit `execution.effect` / `execution.speed` preference
snapshots. The existing v1 `reasoningIntensity` and
`orchestrationIntensity` fields retain their provider-reasoning and
Issue-orchestration meanings; speed is never encoded into
`orchestrationIntensity`. It routes model assignment through the injected
`$tutti-model-allocation` skill so C0-C3 task requirements, the effect floor,
speed ranking, hard capabilities, and effect-scaled validation are applied
consistently. The skill ranks joint Agent/model candidates across every
plausible target: the planning Agent, current provider/model, and provider
defaults receive no affinity bonus, while an equally qualified non-planning
target wins the tie for safely independent work so the planner remains
available for coordination and final integration. Unless the user asks for
supervised execution, the guide directs agents to the permission mode whose
semantic is `full-access` (codex `full-access`, claude-code
`bypassPermissions`): the user's approval happens once at plan review, so
accepted tasks must not stall on mid-task approval prompts. The same resolved
CLI name is used by the plan-revision feedback prompt.
Read-only investigation is allowed while writing the plan; provider-native
planning modes must not substitute for the Tutti plan workflow. Activation
still does not gate tool availability—Tutti CLI capabilities remain available
whether the state is active or inactive—but executing work the user has not
accepted through plan review goes against the user's intent.

## Markdown Revision Contract

Every proposal file uses the `tutti-mode-plan/v1` schema: YAML frontmatter
followed by a non-empty Markdown body. The flow is single-shot: every revision
is one complete document containing the plan narrative (body) plus the full
task graph (`tasks` frontmatter, at least one task, acyclic). `phase` may be
omitted and defaults to `task_graph`. `phase: configuration` remains parseable
only so legacy revision files stay readable; new configuration-phase proposals
and revisions are rejected. Rejected revisions are replaced by a new complete
immutable revision.

The frontmatter owns:

- title and workspace topic ID;
- sequential or parallel execution mode — parallel mirrors the Issue Manager's
  honest-parallelism gate at propose/revise ingress: every task must carry its
  own unique absolute execution directory, or the document is rejected while
  the agent can still fix it (never after acceptance, where the failed
  `create_issue` operation would strand an accepted workflow);
- Issue-level reasoning and orchestration intensity; Tutti Host Context
  compiles the explicit speed preference into a 1-4 upper parallel target while
  the durable scheduler still enforces dependency, isolation, budget, and
  workspace-capacity limits;
- auto or fixed token budget and quota waterline (the token limit is dormant
  and no longer surfaced in UI);
- task IDs, content, priority, assignment (agent target, model plan, model,
  permission mode, reasoning effort), execution directory, and dependencies.

Files live under:

```text
<state-dir>/tutti-mode-plans/<workflow-id>/revisions/<sha256>.md
```

The globally unique workflow ID is the opaque file scope; workspace IDs never
appear in state-directory segments. Publishing uses an atomic link. If the
same content-addressed target already contains the same digest, a retry is an
idempotent success; a mismatch fails closed. Reads verify the stored SHA-256
before parsing. Multiple intentional revisions may reference the same
content-addressed file; revision ID and per-workflow sequence remain unique,
while document path is not revision identity. The OpenAPI response includes
parsed document data for clients; renderers do not read the state directory
directly.

## State And Decision Flow

```text
Agent: tutti plan propose --file <plan.md> --request-id <stable-id>
  (plan.md = complete narrative + full task graph in one document)
  -> daemon commits workflow + revision + the single pending task review
  -> daemon publishes workspace.workflow.updated
  -> AgentGUI pulls the authoritative session-scoped pending snapshot
  -> Agent's turn ends with the propose response (nextAction "stop")
  -> user accepts (optionally with per-task assignment overrides),
     rejects with feedback, or cancels through HTTP; turning Tutti mode
     off with a review still pending cancels the checkpoint the same way
  -> the decision reaches the Agent as a new user message when follow-up
     work is needed; there is no agent-side wait

review rejected ("request changes")
  -> the rejection commits durably with its create_revision operation
  -> the daemon dispatches a feedback turn to the source Agent session
     containing the feedback and revise instructions, idempotent through a
     checkpoint-scoped clientSubmitId and linked back as a feedback turn
     (best-effort; the committed rejection never depends on dispatch)
  -> Agent appends a complete replacement plan with tutti plan revise
  -> revision append atomically completes that exact pending operation
  -> the panel refreshes onto the new pending review

review accepted
  -> the decision durably records any per-task assignment overrides
  -> daemon derives ActionableItems (document values merged with overrides)
  -> deterministic create_issue operation atomically materializes one Issue,
     its tasks, one Tutti execution, and one active initial_schedule checkpoint
  -> materialization creates no Run and invokes no task launcher
  -> operation succeeds with issueId and CLI reports issue_created
```

Legacy two-phase workflows are retired at daemon startup: a one-shot scan
cancels every non-terminal workflow whose current pending checkpoint is a
configuration review (actor `tutti`). Historical accepted configuration
checkpoints may still advance to a task-graph revision, but new
configuration-phase revisions are rejected.

The user-facing HTTP decision endpoint is the sole approval boundary. Agent
CLI commands can observe a decision but cannot approve their own proposal.
Rejection requires feedback. Repeating the same decision is idempotent;
attempting a different decision or deciding a stale checkpoint fails closed.
The decision compare-and-set includes the current workflow revision and status,
so a concurrent revision cannot be overwritten by a late decision. Revision
append likewise compares source session, current revision, workflow status,
checkpoint identity, and checkpoint status in its final SQLite transaction.
This prevents either side of a revise/decide race from reviving stale state.

Proposal and revision writes have a separate durable mutation ledger. Its
unique key is `(workspace, source session, mutation kind, workflow scope,
request ID)`: proposal scope is empty, and revision scope is the workflow ID.
The caller must reuse the request ID when retrying the same mutation after a
timeout or lost response. The same key and Markdown SHA-256 returns the
original workflow/revision/checkpoint result without another mutation; the same
key with different bytes fails as a conflict. A new request ID is an explicit
new mutation even when the Markdown bytes are identical, so content hashes are
never treated as user intent or idempotency identity. The CLI reports both
`requestId` and `replayed`.

Operations use deterministic identities derived from workflow, checkpoint,
and operation kind. The Issue ID is also deterministic for the workflow. Its
reserved namespace and identity constructor live in the daemon-owned
`workspaceworkflow` business model; the reusable workspace Issue package only
validates generic Issue semantics and does not know Tutti workflow identity.
This allows retries to converge on the existing operation or Issue
instead of duplicating a side effect. A failed `create_issue` operation is
requeued through a compare-and-set transition to the same pending operation
when `decide` is replayed. The retry clears stale error
and completion fields; the idempotent Issue materializer then converges on the
same Issue ID.

For a new decision, the checkpoint, resulting workflow status, and deterministic
operation are one SQLite transaction. If operation insertion fails, the entire
decision rolls back. Once that transaction commits, downstream materialization
failure does not turn an accepted checkpoint into an apparent approval error:
the response carries the committed checkpoint and durable failed operation.
Only failure to record the operation outcome is returned as an execution error.
If a decision response is lost, replaying the same decision finds the same
checkpoint and deterministic operation; a succeeded operation is not executed
again. During daemon composition, after the workflow and Issue services exist
but before the public daemon service graph is returned, a one-shot recovery
scan resumes accepted task graphs with pending or failed `create_issue`
operations against the same deterministic Issue identity. Successful rows
leave the recovery set, and a later `plan wait` or decision replay remains a
secondary idempotent repair path. Revision read/parse and other operation-local
failures are recorded on that operation and do not block recovery of later
workflows; startup fails only when the scan fails or a durable operation outcome
cannot be written. No background workflow worker is started.

The workflow service owns the transition policy. The single active checkpoint
kind is the task review; the configuration-review row below is legacy-only
(retired at startup, cancel remains valid):

| Checkpoint                    | Decision | Durable result                                                                    | Agent next action                                |
| ----------------------------- | -------- | --------------------------------------------------------------------------------- | ------------------------------------------------ |
| Task review                   | Accept   | workflow becomes accepted; overrides recorded; `create_issue` operation           | `issue_created` after successful materialization |
| Task review                   | Reject   | workflow remains in progress; feedback stored; feedback turn dispatched to source | revise the complete plan                         |
| Task review                   | Cancel   | workflow becomes canceled                                                         | stop                                             |
| Configuration review (legacy) | Cancel   | workflow becomes canceled                                                         | stop                                             |

Source Agent Session deletion is guarded at the Agent Host boundary against the
entire canonical deletion closure. Before Host closes a runtime or mutates
persistence, the daemon records one durable deletion admission for that exact
closure. Any execution whose source Session is in the closure and whose status
is not `completed` or `archived` rejects the whole request with
`tutti_execution_active` plus the complete protected Issue set. This applies
equally to single deletion, batch deletion, and workspace clear. Materialization
checks the same durable admission in its creation transaction, so a new
execution cannot race an admitted source deletion.

After admission, Host owns runtime closure and delegates canonical Session,
activation snapshot, and Turn deletion to the daemon store in one SQLite
transaction. Host reports terminal success or failure so the admission becomes
`finalized` or `superseded`; a replan must pass admission again. At daemon
startup, admissions left `admitted` by a previous process are superseded before
Host serves requests. This keeps the source deletion guard on the provider-
neutral lifecycle path instead of pre-closing runtimes in an adapter.

Stopping Tutti Mode is an archive saga, not source Session deletion. The archive
request atomically changes the execution to `archiving`, pauses Issue dispatch,
cancels pending checkpoints, wakes, reviewer work, and prepared launches, and
records a durable idempotent operation with actor and reason. The service then
cancels every running Issue Run through the exact-run coordinator and waits for
authoritative settlement. Only after no Run remains `running` may the execution
become `archived` with `archived_at`, `archived_by`, and `archive_reason`.
Cancellation failure leaves a durable failed operation and the execution fenced;
startup recovery retries each incomplete archive independently. There is no
force-archive path.

## HTTP, Events, And Recovery

The schema-first HTTP surface is:

- `GET /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/tutti-mode-activation`
  returns the independent activation projection, including null before the
  first activation;
- `PUT /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/tutti-mode-activation`
  appends an idempotent, revision-checked active or inactive revision;
- `GET /v1/workspaces/{workspaceID}/workflows?sourceSessionId=...` lists every
  workflow for one Agent Session; adding `checkpointStatus=pending` narrows the
  result to workflows with a pending checkpoint. The hand-written client
  exposes these as `listWorkspaceWorkflows` and
  `listPendingWorkspaceWorkflows` respectively;
- `GET /v1/workspaces/{workspaceID}/workflows/{workflowID}` returns one full
  authoritative snapshot;
- `POST /v1/workspaces/{workspaceID}/workflows/{workflowID}/checkpoints/{checkpointID}/decision`
  records a user decision.
- `POST /v1/workspaces/{workspaceID}/tutti-executions/{issueID}/cancel-execution`
  pauses dispatch and cancels active Runs for a proven Tutti-owned Issue
  without archiving the execution;
- `POST /v1/workspaces/{workspaceID}/tutti-executions/{issueID}/archive`
  starts or replays the durable archive saga;
- `GET /v1/workspaces/{workspaceID}/tutti-executions/{issueID}/archive?operationId=...`
  returns its authoritative operation state.

`workspace.tuttimode.updated` and `workspace.workflow.updated` are advisory
invalidation events. The former identifies the changed Session and activation
revision; the latter carries workflow, source Session, checkpoint, and change
kind. Clients re-pull their authoritative HTTP or Session projection. Event
loss is safe because committed SQLite and revision-file state remains
authoritative. Every event-stream `connected` transition, including automatic
reconnect, invalidates every currently subscribed workspace scope. AgentGUI
then lists pending workflows for the active workspace and source Session again;
the new request sequence invalidates any list result that began before the
connection transition. Activation independently comes from the Session
projection. The desktop adapter never opens a panel from transcript text or a
model-authored marker. Renderer state carries the same workspace and
source-session scope key. A scope change immediately hides the previous
snapshot and invalidates in-flight list or decision results before they can
mutate the newly selected Session.

Every daemon service response containing an Agent Session passes through one
canonical response projection seam. That seam joins persisted Protocol v2 Turn
state and the independent `TuttiModeActivation` read projection for create,
resume/get, settings, title, visibility, pin, and list paths. A mutation must
not return a hand-built partial Session, because an authoritative client upsert
would otherwise interpret an omitted activation as removal and clear the badge.

The GUI panel displays only the current revision and its single pending task
review. Before acceptance it exposes every Issue materialization input in that
revision: execution mode, reasoning and orchestration intensity, quota
waterline (the token limit is dormant and hidden), plus each task's ID,
content, priority, execution directory, and dependency IDs. Each task's
assignment (Agent target, model plan, model, permission mode, reasoning
effort) is editable in place through host-supplied option catalogs; the edits
travel with the accept decision as per-task overrides and are durably recorded
on the checkpoint. Accept, reject, and cancel post the decision to the daemon;
rejection feedback is mandatory. Closing the app does not discard the review:
the next mount reconstructs it from the daemon snapshot.

Desktop assignment catalogs load provider composer options through the same
activity-core target-scoped cache used by the main Composer. The workflow
adapter may join that canonical snapshot with the workspace Agent directory and
compatible model-plan catalog, but it does not create a second provider-options
transport path. Model and reasoning entries retain their canonical
`value`/`label` metadata end to end: task overrides persist the opaque provider
`value`, while editable and read-only review surfaces render the `label` and
fall back to the value only for an unknown historical selection.

The Tutti activation additionally carries a session-scoped orchestration
intensity (0-100, default 50). The composer's Tutti Budget popup persists it
as a new activation revision; each turn's frozen snapshot copies it, and the
Tutti Host Context exposes it so the planning Agent chooses decomposition
granularity from it.

## Issue Projection

Accepting a current task graph synchronously asks the daemon-owned Issue
materializer to create an Issue from the derived `ActionableItem`s. One SQLite
transaction creates the Issue, tasks, Tutti execution aggregate at
`awaiting_schedule`/graph revision 1, and its active `initial_schedule`
checkpoint. It maps the Markdown execution profile, budget, assignments,
model choices, directories, and dependency graph into the Issue Manager
contract and records `planningSource = tutti_mode_plan`.

Materialization is inert: it creates no Run and calls no task launcher. The
source Agent must later schedule an explicit task set through the checkpoint-
and-revision-fenced Tutti execution command surface. Existing `autoAccept`
values remain readable migration metadata but have no dispatch authority for
Tutti-owned executions. Manual and `traditional_plan` Issues keep the generic
Issue Manager dispatch behavior.

`plan issue schedule` derives source authority from the trusted invoke context.
While holding the Issue mutation lock, the daemon validates the entire
requested set, including isolation. One SQLite transaction revalidates the
durable caller, active checkpoint, graph revision, task/dependency state,
budget, and workspace capacity. Fixed-budget admission reserves one estimated
allowance for every same-Issue active Run before evaluating the requested set.
The transaction then creates every Run, task-running projection, and durable
launch intent while resolving that checkpoint. Any rejection leaves the
execution and Issue graph unchanged.

Agent launch happens after commit. The launch-intent row is the source of truth
for `clientSubmitId`; delivery workers claim it with a durable lease and pass
that stored value unchanged into Agent Host. The active worker renews the lease
throughout worktree creation and Agent delivery. Ordinary recovery never steals
a leased intent, and startup recovery requeues only an expired lease, so a
second daemon replica starting while the first launch is live cannot enter the
launcher. Response-loss recovery retries the same deterministic
`issue-run:<runID>` identity, allowing Host to converge on the existing
canonical Turn rather than creating a second one. Tutti settlement,
reconciliation, and cancellation resolve this persisted identity from the
launch intent; only generic Issue Runs derive the deterministic default.
The existing Issue Run reconciliation queue also requeues expired launch
ownership and recovers prepared intents on every pass. A daemon that restarts
before the previous owner's last lease expires therefore retries immediately
after that expiry instead of leaving the Run stranded until its hard timeout.

A definite launch failure is terminal only when the adapter can prove that no
canonical Turn exists. An empty create result alone is insufficient: the
adapter also checks Host by the exact persisted `clientSubmitId`. A found Turn,
a lookup error, `ErrSubmitDeliveryUnknown`, or a create error carrying a Turn ID
remains recoverable. Only a clean Host not-found permits terminalization. That
write is one owner-fenced SQLite transaction: the currently leased launch
intent, Run, Task, Issue projection, and deterministic `task_failed` checkpoint
either commit together or all roll back. An expired owner therefore cannot
settle a Run after another daemon has reclaimed its lease.

Every terminal Issue Run (`completed`, `failed`, or `canceled`) creates one
ordered deterministic checkpoint. Completion remains
`pending_acceptance`/`agent_claimed` until the source Agent reviews that
checkpoint. The Agent may resolve the checkpoint by scheduling an exact next
task set, or acknowledge it when another Run is active or a later settlement is
already queued. Acknowledge accepts a successful task, promotes the next
pending checkpoint, and never invokes the generic dispatch frontier. Failed
and canceled checkpoints preserve their terminal task projection. Settlement
repair runs at startup and on the periodic Issue reconciliation cadence, so a
crash after Run persistence cannot lose the review gate.

When every task is terminal and every terminal Run has its settlement
checkpoint, the execution appends one ordered `all_tasks_terminal` checkpoint
with `requiresGoalReview`. Promoting it moves the execution to
`pending_goal_review`; the generic acknowledge command deliberately cannot
resolve this boundary. If a graph mutation adds or reworks tasks while that
terminal checkpoint is still pending, the mutation supersedes the stale
terminal boundary. After the replacement work settles, the same deterministic
terminal checkpoint is rearmed at the current graph revision and moved behind
the new settlement checkpoint. This preserves one terminal identity while
ensuring the final settlement can always promote a current Goal Review. The
settlement recovery scan applies the same readiness check to persisted
executions whose replacement Run had already settled before this invariant was
enforced, so daemon recovery repairs the stranded terminal backlog without
weakening acknowledge fences.

After acceptance the source conversation embeds a live "issue panel view"
(board/list) of the materialized Issue, fed by the same workspace issue events
the Issue Manager consumes. The embed surfaces the durable task structure and
execution state; Tutti-owned scheduling, mutation, and completion authority
comes from the source conversation rather than generic Issue mutation or
automatic dispatch.

The embedded panel's task-level accept and rework controls are source-Agent
prompt actions. They append a localized instruction with the exact Task mention
to the source conversation draft, preserve existing draft content, and require
an explicit user send. The renderer does not translate them into generic Task
status writes. After submission, the source Agent reads canonical execution
state and uses the existing checkpoint/revision-fenced command path. Direct
daemon-owned commands such as execution cancellation remain commands rather
than prompts.

The workflow remains the review and provenance record; the Issue remains the
task/run evidence graph; and the Tutti execution is the orchestration
authority. No renderer or Agent turn recreates the graph, and no Agent is
instructed to issue a second create call. If materialization fails, the
`create_issue` operation records a durable failure code and message, and the
authoritative workflow snapshot remains inspectable through `tutti plan get`
and the HTTP detail endpoint. Startup recovery, replaying the accepted decision,
or observing it through `tutti plan wait` retries the same durable operation;
it never asks the Agent to create the Issue separately.

The Agent-facing `issue create-from-plan` command accepts only
`traditional_plan` provenance. It rejects `tutti_mode_plan`; that provenance
can be written only by the daemon workflow materializer after the matching
checkpoint is durably accepted.

## Validation Boundaries

- Change the OpenAPI source before generated HTTP clients.
- Change the event protocol definition before generated event types.
- Keep workflow transitions and Issue materialization decisions in `tuttid`.
- Keep AgentGUI as a snapshot projector and decision client.
- Do not infer workflow state from provider Plan cards, transcript ordering,
  Markdown markers in messages, or the `/tutti` badge.
- Do not infer activation state from historical `capabilityRefs`; they are
  submission provenance only.
- Do not persist `ActionableItem` separately from the accepted revision.
- Do not expose Agent-callable accept or reject CLI commands.
