# Agent Runtime Preparation

Agent session setup is split into two reusable modules:

- `packages/agent/daemon` owns session control and provider protocols.
- `packages/agent/runtimeprep` owns canonical system prompts, skills,
  capability resolution, provider-local files, launch environment overlays,
  manifests, and cleanup.

Both local and VM-backed hosts execute runtime preparation on the machine where
the provider runs. A VM-backed host may use RPC to reach that machine, but the
RPC service is only a transport/path/security adapter and must call the same
`runtimeprep.DefaultPreparer`; it must not maintain separate Claude or Codex
preparers.

For a Codex Session launched with saver mode enabled, runtime preparation keeps
the selected main-thread model unchanged and materializes a session-scoped
default subagent role backed by `agents/luna_worker.toml`, plus a short managed
`AGENTS.md` routing rule. The role pins only delegated work to the Luna model and reasoning
effort. The routing rule is intentionally advisory and bounded: it favors
self-contained work that would otherwise consume meaningful main-thread
reasoning, context, tool calls, or waiting time and must replace rather than add
main-thread work. One complete independent unit defaults to one worker. More
workers are used only when multiple genuinely independent, non-trivial,
non-overlapping units exist; implementation, tests, and compatibility are not
automatically treated as separate units. Independent read-only or
isolated-worktree units may run in parallel. Workers start before the main
thread inspects their assigned questions or files, and the main thread verifies
returned evidence narrowly instead of repeating the investigation. Write scopes
that cannot be isolated remain sequential. A mechanical workflow stays in the
main thread when one bounded blocking or event-driven command can complete it.
A single worker owns the end-to-end flow only when it would otherwise require
multiple model-driven tool turns. Delegations declare non-goals, allowed state
changes, acceptance criteria, evidence, and retry limits. Workers use the
minimum analysis and tools needed. Each delegation has a concrete tool-call
budget; unless justified otherwise, read-only analysis is capped at 8 calls and
implementation at 20. Read-only analysis does not run tests, repair an
environment, or write files unless explicitly requested. Workers return when
the criteria or budget are reached, and the main thread interrupts a worker if
an intermediate message already supplies sufficient evidence instead of
waiting for further exploration. Workers do not delegate recursively unless
their parent task explicitly authorizes nested delegation and sets a total
nested-worker and tool-call budget. The policy does not create an unbounded
automatic retry loop.

Deployment differences are expressed with `DeploymentProfile` and
`CapabilityPack`. A pack resolves policy, skills, and environment together.
Dynamic host skills use `SkillSource`; per-session skills use `ExtraSkills`.
The canonical template and shared skill bodies remain in runtimeprep so hosts
do not fork the actual prompt content.

Tutti Agent keeps auth, configuration, transcripts, and other mutable state in
its session-scoped `TUTTI_AGENT_HOME`, while Tutti-managed Skills use a
daemon-owned content-addressed store. Runtimeprep computes the stable bundle,
then carries its absolute root as internal launch metadata through the existing
environment overlay. `CodexAppServerAdapter` consumes and strips that metadata,
then applies the full root list with `skills/extraRoots/set` after app-server
initialization and before starting or resuming a thread. This is an
adapter-only contract: materialized bundle roots do not enter the Host public
lifecycle types or user-visible runtime context. A failed RPC fails startup so
the thread cannot silently run without its managed Skills.

Tutti Agent installs its provider-owned embedded Skills beneath the run-scoped
home during app-server initialization. Before the same extra-roots refresh,
the Adapter content-addresses that installed tree under
`agent/system-skill-bundles/v1/<digest>/.system` and atomically replaces the
run-scoped `.system` directory with a symlink to the immutable tree. The RPC
then clears the provider Skill cache before `thread/start` or `thread/resume`,
so both embedded and Tutti-managed Skill paths are canonical and stable in the
rendered developer prefix. A provider content or marker change produces a new
digest automatically. Invalid bundles, unsafe files, replacement failures, or
RPC failures fail closed before a thread starts.

Cursor preparation materializes one session-scoped skill plugin outside the
workspace and supplies it to `cursor-agent acp` through `--plugin-dir`. Cursor
Agent `2026.07.01-41b2de7` does not merge plugin-provided hooks into its ACP hook
executor: only user, project, and team hook sources are loaded. Runtimeprep
therefore must not advertise or materialize plugin hooks for ACP. A focused
background-Task guard implementation remains dormant with unit coverage so it
can be enabled if Cursor adds that capability; it is not a current runtime
guarantee. Never write an equivalent hook into user or project Cursor config to
work around the provider limitation.

Agent Extensions may declare a constrained `runtimePrep` overlay in the signed
composer profile when a provider needs a per-session home or config merge. The
service validates that declaration before launch and passes it through
`PrepareInput.ExtensionRuntimePrep`; runtimeprep must not branch on extension
provider IDs. The overlay can write the standard instructions file, create a
session-scoped home, copy declared opaque files from a user home source, expose
the home through one validated environment variable, materialize Tutti-managed
skills into session-scoped roots derived from the extension's declared workspace
skill roots, and merge those session roots into a supported YAML string-list key
such as `skills.external_dirs`.

For Hermes, the extension profile declares the `HERMES_HOME` overlay instead of
Tutti core knowing `acp:hermes`. The resulting session keeps per-session state,
copies only the declared auth/env/config files needed for provider login, and
references both Tutti's session-scoped extension skill roots and the user's
native skill directory through the declared config merge. Merge precedence is
explicit: the user's original config content is parsed as YAML, existing user
list entries remain first, Tutti session roots are appended next, and the user's
native skill root is appended last. Exact duplicate paths are ignored after
their first occurrence. Invalid YAML or an incompatible target key shape stops
runtime preparation with a clear error instead of silently omitting skills.
The merge uses the repository YAML parser (`yaml.v3`) and only the constrained
string-list merge declared by the signed profile; runtimeprep must not maintain
a Hermes-specific line parser or silently return an unmodified config after a
failed merge. The Tutti-managed skill files are mirrored into the session
runtime root before being referenced from `skills.external_dirs`, so two Hermes
sessions from the same workspace do not share rendered `SKILL.md` files that
contain session or target context.
There is no provider-ID migration branch to remove; if Hermes later exposes a
native ACP/runtime option for additive skill roots and home isolation, remove the
signed `runtimePrep` declaration from the Hermes package and let the generic
instruction/skill preparer handle it like other ACP extensions.

Product-owned responsibilities remain outside the module:

- process or VM transport;
- physical/logical workspace path mapping;
- environment trust filtering;
- account login and token exchange;
- deployment capability availability and profile selection.

## Dedicated Command Projections

An internal dedicated Session may persist a `CommandCapabilityProjection` in
its immutable runtime snapshot. Runtime preparation uses that projection to
render one consistent command guide across initial launch and resume. For
Codex, a projected Session also receives exact command-path approval rules
instead of the normal whole-CLI prefix rule. The daemon independently resolves
the persisted projection for session-aware capability discovery and command
invocation, and fails closed when that projection cannot be resolved.
When `AllowedIDs` is non-empty it is an exact set across public and promoted
integration commands; an unavailable required command fails runtime
preparation rather than silently broadening or degrading the dedicated
Session.

This mechanism narrows normal agent behavior but is not an operating-system
security boundary. Tutti's local daemon credential is available to trusted
same-user CLI clients through the global listener-info file. A hostile
same-user process that escapes the supplied Session context can therefore make
an unscoped request. Features that require protection from a malicious
provider process must add process/filesystem credential isolation (or remove
unscoped credentials) rather than treating runtime environment variables,
generated command guides, provider approval rules, or daemon projection checks
as sufficient isolation.

See the [runtimeprep package README](../../packages/agent/runtimeprep/README.md)
for the public integration contract.
