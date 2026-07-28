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
