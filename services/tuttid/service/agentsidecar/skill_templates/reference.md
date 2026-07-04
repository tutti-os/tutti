---
name: reference
description: Use for `mention://workspace-reference/<id>?source=...&workspaceId=...` links — resolve a referenced app/task artifact set into files to read as context. Reach `$tutti-cli` for CLI syntax only.
---

# Reference

Use when the current user turn contains one or more
`mention://workspace-reference/<id>?source=...&workspaceId=...` links. This skill resolves a
reference handle into its artifact files so you can read them as context. Use injected
`$tutti-cli` as the command reference.

## Mention Contract

Treat the `mention://workspace-reference/...` link as the machine-readable source of truth. Parse:

- URL path: the entity id — `appId` when `source=app`, `topicId` when `source=task`.
- `source`: one of `app`, `task`.
- `workspaceId`: required scope.
- `groupId`: optional sub-scope — an app group when `source=app`, an `issueId` when `source=task`.
  Absent means the whole app / the whole topic.

Do not infer the file set from the mention label.

## Resolve

Run exactly one command to list the referenced files:

`{{CLI_COMMAND}} reference list --source <source> --id <id> [--group-id <groupId>] --json`

The JSON result is `{ "items": [ { "path", "displayName", "sizeBytes", "mediaType" } ] }`,
already flattened. Then read the paths you need with your normal file tools.

## Invocation Rules

- This is a passive reference: list and read only.
- Do NOT open/complete issue runs, do NOT break down issues, do NOT mutate Tutti state, and do
  NOT invoke app commands — even when `source=task`. If the user separately asks to execute or
  break down an issue, switch to `$issue-manager`.
- If the result has zero items, say the reference currently has no artifacts instead of guessing.
- Read only the files relevant to the request; do not dump every file.
