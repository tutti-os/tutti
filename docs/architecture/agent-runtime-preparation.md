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

For any Agent Session launched with RTK saver mode enabled, provider-neutral
runtime preparation keeps the selected model unchanged and resolves the pinned
Tutti-owned `rtk` executable. Packaged Desktop supplies it from app resources;
other hosts resolve the SHA-256-verified `rtk-saver` managed-runtime component.

RTK saver mode is independent from the existing Codex saver mode. The latter
remains Codex-only and installs the session-scoped Luna worker role and Codex
routing policy; enabling either mode does not implicitly enable or disable the
other.
Preparation copies that executable and the canonical `RTK.md`
into the exact Session runtime and prepends only the private binary directory to
that Session's `PATH`. Session-private Codex, Tutti Agent, and OpenCode
`AGENTS.md` files start with an absolute `@<runtime>/rtk/RTK.md` reference,
matching RTK's native Codex integration. The common Tutti Runtime policy also
carries the same RTK instructions inline through every provider's native
instruction channel as a compatibility fallback (for example, Claude's
system-prompt file and Cursor's plugin context). Claude and Cursor install
native pre-tool hooks, OpenCode installs a command-rewrite plugin, and Hermes
installs a session-home plugin. Kimi receives a session-home plugin system
prompt because its pre-tool hooks can block but cannot mutate tool input. RTK's
database, tee output, and telemetry policy are also isolated under the Session
runtime.

Runtime preparation deliberately does not inspect the user PATH or install RTK
through Homebrew, Cargo, an upstream shell script, or any other global
toolchain. A missing or invalid bundled/managed artifact fails closed. Disabled
Sessions receive no RTK files or environment overlay, and cleanup removes only
the enabled Session's recorded runtime paths. The Tutti integrated terminal
also prepends the Tutti-owned RTK directory to its child environment, but Tutti
never mutates the operating-system or user-global PATH.

Claude Code follows a separate SDK compatibility contract. The daemon keeps the
SDK-paired executable under the private Agent runtime root, and runtime
preparation passes its absolute path to the Claude SDK. A user-level `claude`
command is published only when the complete effective command search contains no
independently installed Claude executable. If a later reconciliation finds an
external command, the daemon removes only a user entry that is still provably
Tutti-owned: it atomically quarantines the current entry, inspects the moved
object, and restores it without replacement if ownership changed concurrently.
The private stable hop stays active. This prevents the managed runtime from
shadowing or deleting a user's CLI while preserving Tutti's existing managed
runtime selection inside Claude Sessions.

Deployment differences are expressed with `DeploymentProfile` and
`CapabilityPack`. A pack resolves policy, skills, and environment together.
Dynamic host skills use `SkillSource`; per-session skills use `ExtraSkills`.
The canonical template and shared skill bodies remain in runtimeprep so hosts
do not fork the actual prompt content. `PrepareInput.SharedInvocation` and
`EnabledConnectors` render the session-sticky enable-set protocol in
`connector-discovery`: a non-empty set is the current user-enabled connectors,
and an empty set is discovery mode over the listed connectors. Runtimeprep
renders each available Connector key, display name, and alias into one routing
index. A request matching any generated entry, or asking to operate a service
represented by that index, must begin with `connector available --json` before
the provider asks clarifying questions, reads a Connector-owned Skill, or calls
a Connector interface. The current Turn's discovery result is authoritative;
the policy does not hard-code service-specific mappings. Shared invocations add
Caller-versus-Owner routing rules. Hosts pass the full enable set on each turn
as connector prompt blocks; `packages/agent/daemon` injects only enable/disable
deltas into the provider-visible turn.

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

Cursor preparation materializes one session-scoped plugin outside the workspace
and supplies it to `cursor-agent acp` through `--plugin-dir`. The plugin carries
the resolved Skill bundle. Runtimeprep also renders the canonical Tutti policy
and a catalog of the bundle's actual materialized paths from the same resolved
capability profile; the Cursor adapter must not maintain a separate hard-coded
Skill catalog. Re-preparing the same Session replaces current managed Skills and
removes only stale Tutti-managed entries, so resume cannot accumulate suffixed
duplicates or retain a capability that is no longer resolved. Because Cursor
ACP does not project plugin Skills or Rules into
the model context, the standard ACP adapter appends that prepared context to the
first provider prompt only. It is provider-only content and is never projected
as a user message; a newly connected or resumed provider Session receives it
again. This makes Tutti capabilities available at session start without writing
provider instructions or Skills into the workspace. Current Cursor Agent
runtimes discover a plugin-scoped `hooks/hooks.json`. When RTK saver mode is
enabled, runtimeprep adds a `preToolUse` Shell hook that runs `rtk hook cursor`;
it remains inside the Session plugin and never writes user or project Cursor
configuration. A focused background-Task guard remains dormant and independent
of this Shell rewrite hook.

OpenCode preparation follows the same session-isolation rule as Codex without
changing OpenCode's standard ACP transport. It creates a session-scoped
`OPENCODE_CONFIG_DIR`, writes the canonical Tutti runtime policy to that
directory's `AGENTS.md`, installs an RTK `tool.execute.before` rewrite plugin,
and materializes the resolved Tutti Skill bundle under its native `skills/`
root. Re-preparing the Session reconciles that managed root
to the current resolved bundle while preserving unmanaged entries. This happens
for every Session, including Sessions
without a model access plan, so mention-driven handoff, context, issue, and
workspace-app behavior never depends on user-installed Skills. A bound model
access plan continues to use the `OPENCODE_CONFIG` file in the same isolated
directory; provider settings and permissions continue through their existing
OpenCode config layers.

Agent Extensions may declare a constrained `runtimePrep` overlay in the signed
composer profile when a provider needs a per-session home or config merge. The
service validates that declaration before launch and passes it through
`PrepareInput.ExtensionRuntimePrep`; runtimeprep must not branch on extension
provider IDs. The overlay can write the standard instructions file, create a
session-scoped home, copy declared opaque files from a user home source, expose
the home through one validated environment variable, materialize Tutti-managed
skills into session-scoped roots derived from the extension's declared workspace
skill roots, and merge those session roots into a supported YAML string-list key
such as `skills.external_dirs`. A signed profile may additionally list safe
relative `sharedDirs` beneath that same source home. Runtimeprep projects those
mutable provider-owned directories into each isolated session home instead of
copying them, so verified helper binaries and equivalent caches survive session
cleanup. Configuration, authentication, provider state, and undeclared paths
remain session-local; Tutti core never selects a shared directory by provider
ID.

Source-home resolution is also descriptor-driven. A declared source environment
variable has highest priority. On Windows, a `sourceDefaultRel` whose top-level
name starts with a dot first resolves under the native user cache root with the
leading dot removed (for example `.vendor` becomes `%LOCALAPPDATA%\vendor`). If
that native directory does not exist, runtimeprep falls back to the literal
user-home-relative directory so migrated Unix-style locations keep working.
Other platforms keep the literal user-home-relative default. The shared resolver
remains provider-neutral and only copies files explicitly declared by the signed
profile.

For Hermes, the extension profile declares the `HERMES_HOME` overlay instead of
Tutti core knowing `acp:hermes`. The resulting session keeps per-session state,
copies only the declared auth/env/config files needed for provider login, and
references both Tutti's session-scoped extension skill roots and the user's
native skill directory through the declared config merge. It declares `bin` as
a shared mutable directory because Hermes installs its checksum-verified Tirith
helper there on supported platforms. When the stable directory is still empty,
preparation searches manifest-owned, same-provider legacy session homes from
newest to oldest and seeds it from the first usable cache; subsequent sessions
reuse that helper instead of placing a GitHub Release download on every first
terminal command. Windows keeps the same declarative projection contract even
though the current Hermes runtime does not ship Tirith for Windows. Merge precedence is
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
