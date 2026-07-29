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

Deployment differences are expressed with `DeploymentProfile` and
`CapabilityPack`. A pack resolves policy, skills, and environment together.
Dynamic host skills use `SkillSource`; per-session skills use `ExtraSkills`.
The canonical template and shared skill bodies remain in runtimeprep so hosts
do not fork the actual prompt content.

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
