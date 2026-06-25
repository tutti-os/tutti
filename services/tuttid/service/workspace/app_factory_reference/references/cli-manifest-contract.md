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

## Self-Open Commands

When an app has pages, records, projects, files, runs, or other deep-linkable UI targets, expose a business-level open command instead of making callers build raw frontend routes.

The business open command should be the complete integration surface. Callers, including agents and other apps, should call `open-project`, `open-file`, `open-run`, or a similar app-owned command and stop there. Do not make callers interpret a returned route or parameter payload and then decide whether to invoke daemon-owned `app open`; the app handler owns target resolution, route construction, and desktop activation.

Good command paths:

- `open-project` with `project-id`
- `open-file` with `file-id` or another app-owned stable id
- `open-run` with `run-id`
- `open-context` when the target is a broader workspace context

Avoid command names or inputs that leak router implementation such as `open-route`, `path`, `url`, `pathname`, or arbitrary query strings. The handler owns route construction.

Example:

```json
{
  "path": ["open-project"],
  "summary": "Open a project",
  "description": "Open one project in this app.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "project-id": {
        "type": "string",
        "description": "Stable project id."
      }
    },
    "required": ["project-id"]
  },
  "output": {
    "defaultMode": "json",
    "json": true
  },
  "handler": {
    "kind": "http",
    "method": "POST",
    "path": "/tutti/cli/open-project",
    "timeoutMs": 30000
  }
}
```

Handler rules:

- Validate `body.input` against the declared schema, then verify the target exists or can be resolved.
- Map the validated business input to an app-owned origin-root route such as `/projects/<encoded-id>` or `/runs/<encoded-id>`. The route must start with `/` and must not be a full URL or protocol-relative URL.
- Request desktop activation from inside the handler by invoking `$TUTTI_CLI` with an argv list equivalent to `--json app open --app-id "$TUTTI_APP_ID" --route "<route>"`. `--json` requests machine-readable CLI output. Do not build a shell string. Add `--param key=value` only for small stable view options, and `--state-json` only for non-essential view state; keep primary target identity in the route.
- If `$TUTTI_CLI` is missing or daemon-owned `app open` fails, return a concise JSON status such as `{"openRequested":false,"route":"/projects/123","projectId":"123","reason":"tutti_cli_unavailable"}` instead of handing the route back for the caller to finish. Normal browser or dev environments should stay usable without desktop activation.
- Return a concise JSON output such as `{"openRequested":true,"route":"/projects/123","projectId":"123"}`. Treat the command as an activation request, not proof that the user has seen the page.
- Do not require callers to pass `app-id`; the running app should use `$TUTTI_APP_ID`.
- Do not call the app's own open CLI command recursively. Use the daemon-owned `app open` command only to activate the webview after resolving the target.
- Keep route state recoverable. Do not encode locale, theme, transient panel state, host absolute paths, `.tutti` state paths, or secrets in the route or params.

Frontend/runtime rules:

- Serve every self-open route directly. Static or SPA apps should fall back to the app shell for valid app routes instead of returning 404.
- On first open, Tutti Desktop navigates the app webview to the resolved route.
- When the app is already mounted and receives another open request, handle it with `window.tuttiExternal?.workspace?.onLaunchIntent?.((intent) => { ... })` and route the existing frontend to `intent.route`.
- The launch intent may contain `params` and `state`, but the route remains the stable public entrypoint.

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
