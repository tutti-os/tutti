# Standalone Agent Tool Surface Adapter

## Background and goal

Standalone Agent windows render AgentGUI without the Workspace Workbench. The
provider-login, link, Browser Use, and file-preview paths nevertheless reused
Workspace launch contracts. Some standalone paths therefore targeted the
AgentGUI surface host (which is not a tool host) or escaped to an OS app.

The goal is to keep the semantic launch contracts shared while adapting their
presentation at the Desktop surface boundary:

- provider login opens a new Terminal tab in the right sidebar;
- ordinary HTTP links and Browser Use open the right-side Browser;
- file preview opens the right-side Files tool; only explicit reveal/Open in
  Finder uses the OS;
- `reveal: false` may mount Browser without expanding the sidebar.

There is one standalone Agent window per workspace workflow. This change does
not introduce window ownership or multi-Agent-window selection.

## Current architecture and complete paths

Provider login currently follows
`AgentEnv -> provider terminal command runner -> surface.host.launchNode`. In a
Workspace window the host is a real Workbench host. In a standalone window the
AgentGUI host only represents the Agent node, so it cannot launch Terminal.

Ordinary links follow
`AgentGUI link action -> standalone link adapter -> shell.openExternal`, and
file preview follows
`workspace file preview host -> standalone presenter -> host files openFile`.
Both leave Tutti instead of selecting a sidebar tool.

Browser Use follows
`tuttid/browser request -> Electron main browser automation coordinator -> user
Browser host`, even when a ready standalone Agent Browser host exists.

## Target architecture and complete paths

Semantic requests remain surface-neutral and are resolved by a Desktop
presenter registered for the current renderer:

- login: `AgentEnv -> terminal runner -> workspace terminal-login coordinator
-> standalone presenter -> create terminal session -> add Terminal tab`;
- HTTP link: `AgentGUI link action -> workspace Browser launch coordinator ->
standalone presenter -> open Browser tab -> create/activate page`;
- file preview: `file preview surface host -> standalone presenter -> Files
launch coordinator/state -> open Files tab and select path`;
- Browser Use: `renderer submit result -> Turn surface claim -> browser
automation coordinator -> originating Agent or Workspace Browser host`. The
  coordinator briefly waits when automation races ahead of the canonical Turn
  claim, then creates/waits for the claimed host; unclaimed legacy Turns retain
  the user/Workspace fallback.

Explicit external-link actions remain system-browser actions. Explicit
reveal/Open in Finder remains a host-files reveal action.

## Repository and module changes

Only `tutti` changes.

- Desktop main browser automation coordinator: record the validated renderer
  origin for each canonical Turn, then select/create that surface's Browser;
  preserve the user-host fallback for unclaimed legacy Turns.
- provider terminal runner: prefer the workspace-scoped terminal-login
  coordinator and retain Workbench launch fallback.
- standalone Terminal presenter/runtime: create the session with command and
  cwd, create one sidebar tab per request, and retain startup-action gating.
- standalone Browser sidebar adapter: register the shared Browser launch
  coordinator, wait for the selected tab controller, and implement reveal vs
  silent mount.
- standalone link routing: send ordinary HTTP actions to the Browser
  coordinator; preserve explicit external actions.
- standalone file-preview presenter: select Files in the sidebar rather than
  calling the OS open-file API.
- standalone Agent environment binding: bind provider launch behavior to the
  right-side tool host group, not the AgentGUI surface host.

Tasks and Apps already use standalone presenters and sidebar state, so their
contracts do not change.

## Reuse and Adapter boundary

Shared semantic coordinators, terminal runtime, Browser controller, Files pane,
and provider startup-input gate are reused. Desktop owns the mode-specific
presenters and top-level focus/tab behavior. AgentGUI, provider protocol, and
daemon code do not learn about sidebar tabs, Electron windows, or OS reveal.

## Explicit non-goals

- no multi-Agent-window selection or `windowId` protocol;
- no new Browser, Terminal, Files, Tasks, or Apps implementation;
- no AgentGUI lifecycle/state changes for Desktop tool chrome;
- no change to explicit system-browser or Open in Finder actions;
- no provider authentication or credential format changes.

## Migration and compatibility

There is no persisted-data migration. Existing Workspace presentation remains
the fallback when no renderer presenter or Turn claim exists. Existing sessions
and saved layouts keep their current schema.

## Risks and rollback

The main risks are a presenter-registration race, a missing/forged Turn claim,
targeting the wrong Browser tab, and leaking a terminal session if tab creation
fails. Registration happens before the tool host is announced; Electron main
validates claims against the sender window; Browser launch waits for the exact
Turn claim and tab controller with bounded timeouts; terminal creation failure
cleans up the session.

Rollback is a single commit/MR revert. Because no schema or daemon contract is
changed, rollback needs no data repair.

## Tests and acceptance

- unit: terminal coordinator preference/fallback, new-tab creation, startup
  action, link routing, file preview routing, Browser host selection and reveal
  policy;
- static: Desktop typecheck and changed-file repository checks;
- build: Desktop production build;
- integration: exercise provider command through the coordinator/presenter and
  Browser automation through main host selection and renderer response;
- manual acceptance: Claude login opens a new right Terminal tab; ordinary HTTP
  and Browser Use stay in right Browser; file preview stays in Files; Open in
  Finder uses Finder; `reveal:false` does not expand the sidebar.

## Phased implementation

1. Add the standalone Terminal presenter and bind the real tool host.
2. Route Browser, HTTP links, and Files through their shared coordinators.
3. Add contract tests, documentation, typecheck/build, and integration checks.
4. Obtain independent review, fix findings, then push one MR.
