# Tutti App CLI Manifest Contract

Create `tutti.cli.json` when the app exposes capabilities to the Tutti ecosystem. The app manifest must declare:

```json
{
  "cli": {
    "manifest": "tutti.cli.json"
  }
}
```

Shape:

```json
{
  "schemaVersion": "tutti.app.cli.v1",
  "scope": "automation",
  "description": "Schedule and review recurring automation runs.",
  "documentation": {
    "file": "COMMANDS.md"
  },
  "commands": [
    {
      "path": ["run"],
      "summary": "Run an automation",
      "description": "Run one named automation.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "dry-run": { "type": "boolean" }
        },
        "required": ["name"]
      },
      "output": {
        "defaultMode": "json",
        "json": true
      },
      "handler": {
        "kind": "http",
        "method": "POST",
        "path": "/tutti/cli/run",
        "timeoutMs": 30000
      }
    }
  ]
}
```

Rules:

- `scope` is required and may differ from `appId`.
- If the user asks to connect the app to the Tutti ecosystem, `tutti.cli.json` is required and must expose at least one useful command.
- `scope` and every command path segment must use lowercase letters, numbers, and hyphen only.
- `description` is optional. When present, it describes the CLI scope as a whole for app-level discovery surfaces such as `tutti --help` and `@app` mentions.
- Command `path` must not repeat `scope`.
- `documentation` is optional. When present, `documentation.file` must be a relative package path to app-owned command documentation, usually `COMMANDS.md`. CLI capabilities expose the resolved absolute documentation path for help output.
- Handler `kind` must be `http`, `method` must be `POST`, and `path` must start with `/tutti/cli/`.
- Do not declare host, port, or full URLs; Tutti routes to the app runtime port.
- Handler `timeoutMs`, when present, must be an integer between `1000` and `600000`.
- Supported input schema is a small object-only subset: `type`, `properties`, `required`, and property `description`.
- Property `type` may be `string`, `boolean`, or `integer`.
- `defaultMode` may be `json` or `table`; table output must declare static columns.
- Successful handler responses must return the `CliCommandOutput` shape directly. Do not wrap it in an invoke response such as `{"ok":true,"output":...}`.

Runtime request body:

- Tutti posts an invoke envelope to the app handler, not the command input object directly.
- App handlers must validate and execute `body.input` against the command `inputSchema`.
- Keep accepting direct raw input only as an optional local-test/backward-compatibility path; do not require it for Tutti runtime calls.

Example handler request body:

```json
{
  "schemaVersion": "tutti.app.cli.invoke.v1",
  "commandId": "automation.run",
  "appId": "app_automation",
  "scope": "automation",
  "path": ["run"],
  "workspaceId": "workspace-id",
  "input": {
    "name": "daily-report",
    "dry-run": true
  },
  "outputMode": "json",
  "context": {
    "source": "cli",
    "parentCommandId": null
  }
}
```

Successful handler response body:

```json
{
  "kind": "json",
  "value": {
    "ok": true,
    "runId": "run-123"
  }
}
```

Table output response body:

```json
{
  "kind": "table",
  "columns": [
    { "key": "name", "label": "Name" },
    { "key": "status", "label": "Status" }
  ],
  "rows": [{ "name": "daily-report", "status": "queued" }]
}
```

Text output response body:

```json
{
  "kind": "text",
  "text": "Queued daily-report."
}
```

Error response body:

```json
{
  "error": {
    "code": "invalid_input",
    "message": "Missing required input: name"
  }
}
```

Return a non-2xx HTTP status for errors. Tutti surfaces the `error.message` to CLI callers.
