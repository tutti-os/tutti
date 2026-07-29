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
      "visibility": "public",
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

- `scope` is required and may differ from `appId`. Agent and app-mention integrations must match commands by app id metadata, then invoke the listed CLI scope; they must not assume `scope == appId`.
- If the user asks to connect the app to the Tutti ecosystem, `tutti.cli.json` is required and must expose at least one useful command.
- `scope` and every command path segment must use lowercase letters, numbers, and hyphen only.
- `description` is optional. When present, it describes the CLI scope as a whole for app-level discovery surfaces such as `tutti --help` and `@app` mentions.
- Command `path` must not repeat `scope`.
- Command `visibility` is optional. It may be `public` or `integration`; when omitted, it defaults to `public`.
- `public` commands appear in ordinary Tutti CLI help, Agent command guides, and command discovery.
- `integration` commands are hidden from ordinary user and Agent discovery, but are still available to app-runtime integrations that call local capabilities through `$TUTTI_CLI`.
- `visibility` is not an authorization boundary. Do not use `integration` for secrets, privileged operations, or commands that must be blocked from a user who already knows the command.
- `documentation` is optional. When present, `documentation.file` must be a relative package path to app-owned command documentation, usually `COMMANDS.md`. CLI capabilities expose the resolved absolute documentation path for help output.
- Handler `kind` must be `http`, `method` must be `POST`, and `path` must start with `/tutti/cli/`.
- Do not declare host, port, or full URLs; Tutti routes to the app runtime port.
- Handler `timeoutMs`, when present, must be an integer between `1000` and `600000`.
- Handler `timeoutMs` is a per-invocation transport budget, not a workflow deadline or total CLI wait timeout.
- Supported input schema is a small object-only subset: `type`, `properties`, `required`, and property `description`, `enum`, and `default`.
- Property `type` may be `string`, `boolean`, or `integer`.
- Property `enum` and `default` values must match the declared property type. Treat `default` as manifest metadata for help and discovery; app handlers must still apply any business default they need.
- `defaultMode` may be `json` or `table`; table output must declare static columns.
- Successful handler responses must return the `CliCommandOutput` shape directly. Do not wrap it in an invoke response such as `{"ok":true,"output":...}`.

## Wait Commands

Commands named `wait` should wait until the underlying run, session, or durable
execution reaches a stop point. Do not expose an App-owned observation-window
timeout or require callers to invoke the command repeatedly.

Declare a wait command with `execution.mode`:

```json
{
  "path": ["runs", "wait"],
  "summary": "Wait for a run stop point",
  "execution": {
    "mode": "wait"
  },
  "inputSchema": {
    "type": "object",
    "properties": {
      "run-id": {
        "type": "string",
        "description": "Run id to await."
      }
    },
    "required": ["run-id"]
  },
  "output": {
    "defaultMode": "json",
    "json": true
  },
  "handler": {
    "kind": "http",
    "method": "POST",
    "path": "/tutti/cli/runs/wait",
    "timeoutMs": 30000
  }
}
```

When the execution is still active, return the current compact state plus an
internal continuation:

```json
{
  "kind": "json",
  "value": {
    "run": {
      "runId": "run-123",
      "status": "running"
    }
  },
  "continuation": {
    "state": "pending",
    "retryAfterMs": 1000
  }
}
```

`retryAfterMs` must be between `250` and `60000`. Prefer an event-driven or
long-polling handler when the App already has an efficient change signal. If a
handler returns promptly, choose a retry delay that avoids a hot status-query
loop. The Tutti CLI suppresses pending outputs, waits for the declared delay,
and invokes the same command again.

At a stop point, return the final JSON output without `continuation`:

```json
{
  "kind": "json",
  "value": {
    "run": {
      "runId": "run-123",
      "status": "completed"
    }
  }
}
```

Wait commands receive the common CLI flag `--timeout-ms`. It is reserved by
Tutti and must not be declared in the App input schema. Omitting it waits until
a stop point. When the total deadline expires, the CLI returns exit code zero
with a JSON result shaped like:

```json
{
  "reason": "wait_timeout",
  "timedOut": true,
  "executionContinues": true,
  "lastResult": {
    "run": {
      "runId": "run-123",
      "status": "running"
    }
  }
}
```

This result only stops the local wait. It must not cancel or interrupt the
underlying execution. Ctrl-C has the same non-canceling behavior.

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
