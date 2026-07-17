# Agent Reference Mention Resolution

Status: current implemented protocol

## Purpose

A `workspace-reference` mention is a compact, workspace-scoped handle to a set
of app or task artifacts. The composer sends the handle unchanged. The agent
resolves the current file set through the injected `reference` skill and Tutti
CLI only when those files are needed.

This avoids embedding a recursively expanded file list in the prompt. It also
means resolution is live: artifacts created or removed after the message was
composed are reflected when the agent resolves the mention.

The picker and source browsing model are documented separately in
[Agent Reference Sources](./agent-reference-sources.md).

## Mention Contract

Canonical shape:

```text
mention://workspace-reference/<id>?source=<app|task>&workspaceId=<workspace-id>
```

An optional `groupId` narrows the reference:

```text
mention://workspace-reference/<id>?groupId=<group-id>&source=<app|task>&workspaceId=<workspace-id>
```

The fields have these meanings:

| Field         | `source=app`             | `source=task`            |
| ------------- | ------------------------ | ------------------------ |
| path `<id>`   | workspace app id         | topic id                 |
| `groupId`     | app-owned artifact group | issue id                 |
| no `groupId`  | all artifacts in the app | all outputs in the topic |
| `workspaceId` | required workspace scope | required workspace scope |

The Markdown label and optional `count` query value are presentation metadata.
They are not resolution authority. New mentions do not embed file paths,
credentials, app commands, or serialized `files` arrays.

UI presentation hydration is also separate from artifact resolution. A
workspace-scoped `RichTextMentionService` may resolve the current label and app
icon into an in-memory snapshot for composer, conversation, and AgentGUI
surfaces. That snapshot is never written back to the mention URI or Markdown;
if it is unavailable, the stored label and `MentionPill` semantic glyph are the
required fallback.

`workspace-reference` is a passive artifact reference. It is distinct from:

- `workspace-app`, which routes an agent to an app command surface;
- `workspace-issue`, which routes to issue inspection or execution workflows;
- `agent-target` and `agent-session`, which route through agent handoff.

## End-To-End Flow

```text
reference picker
  -> ReferenceHandle { source, id, groupId? }
  -> one workspace-reference Markdown mention
  -> provider runtime mention routing
  -> injected reference skill
  -> tutti reference list --source ... --id ... [--group-id ...] --json
  -> shared daemon reference resolver
       app  -> AppCenterService.ListReferences
       task -> IssueManagerService.GetIssueDetail or SearchIssueOutputs
  -> flat artifact file list
  -> agent reads only the relevant returned paths
```

The composer never expands the reference into prompt paths. The runtime routing
policy instructs every supported provider to use the `reference` skill first.
Provider-specific policy may strengthen this ordering, but it must preserve the
same protocol and CLI route.

## Composer And Picker Ownership

`packages/workspace/file-reference` defines the source-neutral
`ReferenceHandle`:

```ts
interface ReferenceHandle {
  source: "app" | "task";
  id: string;
  groupId?: string;
}
```

Navigable app and task source backends decode their own opaque picker node ids
through `describeReferenceHandle`. Shared picker code does not interpret those
source-specific node ids.

AgentGUI serializes the selected handle as one Markdown link. Loose individual
files still use ordinary file mentions; only a navigable artifact group becomes
a `workspace-reference`. Clicking an existing reference chip may reopen and
locate the corresponding picker source, but that display behavior does not
change the serialized protocol.

## Daemon Resolution

The CLI command is:

```text
tutti reference list \
  --source <app|task> \
  --id <appId|topicId> \
  [--group-id <app-group-id|issue-id>] \
  [--query <file-name-filter>] \
  [--limit <count>] \
  --json
```

Workspace scope comes from the authenticated CLI invocation context and must
match the mention's workspace. The default and maximum result size is 1000.

The JSON result is source-neutral:

```json
{
  "items": [
    {
      "path": "/resolved/artifact/path",
      "displayName": "report.md",
      "sizeBytes": 123,
      "mediaType": "text/markdown",
      "createdAtUnixMs": 1780000000000
    }
  ]
}
```

`services/tuttid/service/cli/providers/refresolve` is the shared resolver behind
both `reference list` and workspace-reference expansion in issue/task detail.
This keeps both consumers on the same source semantics and service egress.

### App Source

The resolver calls `AppCenterService.ListReferences`, walks nested groups,
paginates, deduplicates files by path, and returns a flat list. It does not call
workspace app HTTP endpoints directly; App Center remains the single app
reference egress.

### Task Source

With `groupId`, the resolver loads that issue and maps its latest outputs.
Without `groupId`, it searches outputs within the topic identified by `id`.
Both paths use `IssueManagerService` in process.

## Runtime Skill Routing

The generated runtime policy maps
`mention://workspace-reference/<id>?source=...&workspaceId=...` to the injected
`reference` skill. The skill:

1. treats the URI rather than its label as the machine-readable source;
2. runs one `reference list` command for the handle;
3. reads only files relevant to the user's request;
4. reports an empty artifact set instead of guessing.

The skill is read-only. A task reference does not authorize opening, completing,
or breaking down an issue. An app reference does not authorize invoking app
commands. If the user separately requests those actions, routing switches to
the corresponding issue-manager or workspace-app workflow.

## Invariants And Failure Behavior

- `source` is exactly `app` or `task`.
- `id` and workspace scope are required; `groupId` is optional.
- Mention labels, icons, and counts never determine the resolved file set.
- Resolution goes through daemon services, not renderer recursion or direct app
  HTTP assembled by the CLI provider.
- Returned paths are data to inspect, not implicit permission to mutate Tutti
  state.
- The resolver bounds traversal and output to prevent unbounded artifact trees.
- Missing containers, daemon failures, and inaccessible sources are reported as
  resolution failures; callers must not reconstruct paths or stale file lists.
- Zero returned items means the reference currently has no matching artifacts.

## Validation

The durable test surface covers:

- app and task handle decoding from picker nodes;
- one-link composer serialization without embedded file arrays;
- Markdown parse/render round trips and optional presentation metadata;
- app hierarchy traversal, pagination, deduplication, query, and limits;
- issue-level and topic-level task output resolution;
- shared issue/task inline reference expansion;
- generated runtime policy and injected reference skill routing.

Related documents:

- [Agent Reference Sources](./agent-reference-sources.md)
- [Agent GUI Node](./agent-gui-node.md)
- [Agent Activity Packages](./agent-activity-packages.md)
