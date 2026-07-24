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

Treat the `mention://workspace-reference/...` link as the machine-readable source of truth.

{{if has "references.task.list"}}

- URL path: referenced task id.
- `source`: must be `task`.
- `workspaceId`: workspace scope supplied by the trusted runtime context.
- optional `groupId`: topic/group scope when present.
  {{else if has "references.reference.list"}}
- URL path: referenced entity id.
- `source`: use only a value accepted by the current command schema: {{range inputValues "references.reference.list" "source"}}`{{.}}` {{end}}
- `workspaceId`: workspace scope supplied by the trusted runtime context.
- optional `groupId`: group scope when present.
  {{else if has "reference.list"}}
- URL path: referenced entity id.
- `source`: use only a value accepted by the current command schema: {{range inputValues "reference.list" "source"}}`{{.}}` {{end}}
- `workspaceId`: workspace scope supplied by the trusted runtime context.
- optional `groupId`: group scope when present.
  {{else}}
  The current Host does not advertise reference resolution. Parse the URI as data, but do not guess a `reference` command.
  {{end}}

Do not infer the file set from the mention label.

## Resolve

{{if has "references.task.list"}}
Run `{{command "references.task.list" (args "source" "task" "id" "<id>")}}`, then read returned paths.
{{else if has "references.reference.list"}}
Run `{{command "references.reference.list" (args "source" "<source>" "id" "<id>")}}`, then read returned paths.
{{else if has "reference.list"}}
Run `{{command "reference.list" (args "source" "<source>" "id" "<id>")}}`, then read returned paths.
{{else}}
Reference resolution is unavailable in the current Host command snapshot. Do not invent a fallback command.
{{end}}

The JSON result is `{ "items": [ { "path", "displayName", "sizeBytes", "mediaType" } ] }`,
already flattened. Then read the paths you need with your normal file tools.

## Invocation Rules

- This is a passive reference: list and read only.
- Do NOT open/complete issue runs, do NOT break down issues, do NOT mutate Tutti state, and do
  NOT invoke app commands — even when `source=task`. If the user separately asks to execute or
  break down an issue, switch to `$issue-manager`.
- If the result has zero items, say the reference currently has no artifacts instead of guessing.
- Read only the files relevant to the request; do not dump every file.
