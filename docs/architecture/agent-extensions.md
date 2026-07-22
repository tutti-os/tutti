# Agent Extensions

Status: current implemented architecture

Agent Extensions let independently released ACP agents integrate with Tutti
without adding provider-specific executable code to this repository. An
extension is declarative data: a manifest, discovery/tool/capability/composer
profiles, locale resources, and static assets.

## Trust And Distribution

Configured sources live in `config/tutti.defaults.json`. Each source pins an
agent key, HTTPS `versions.json` URL, feature flag, signing key ID, and Ed25519
public key. `tuttid` accepts only active compatible releases whose canonical
release JSON signature, artifact SHA-256, byte size, manifest identity, and
package contents all validate.

Release ZIPs are data-only. Installation rejects path traversal, symlinks,
executable regular files, unsupported file types, excessive entry counts, and
excessive compressed or expanded sizes. Directory entries may carry the normal
execute/search bits required to traverse them. The package may describe an exact
standard npm, pnpm, or uv runtime installation, or pin raw official executable
artifacts, but it never carries executable code itself. Binary artifact
metadata remains inside the v2 manifest covered by the extension release's
Ed25519 signature and signed package digest; there is no manifest v3 or
reinterpretation of existing package-manager manifests.

Each concrete Agent repository owns its reproducible archive, release signing,
versions generation, verification, and S3/CloudFront workflow. Tutti consumes
signed immutable releases but does not build or upload third-party Agent
artifacts. The provider-independent setup and release procedure lives in the
`tutti-os/tutti-agent-extension-skill` repository.

Local development has one explicit exception modeled after the App Center
catalog override. In `development` only,
`TUTTI_AGENT_EXTENSION_<KEY>_PACKAGE_DIR` may select an unpacked package for a
configured source. The daemon applies the same data-only file, size, manifest,
profile, asset, and runtime-contract validation, copies the package into its
owned state, stamps a content-addressed `+local.<digest>` snapshot version, and
registers the normal fixed Agent Target. It never runs from the mutable source
directory. Production ignores this override and continues to require the
signed HTTPS release path.

## Installation And Runtime Ownership

Verified installations are immutable and stored under:

```text
<state>/agent/extensions/<agentKey>/<version>/
<state>/agent/extensions/<agentKey>/active.json
```

Development package snapshots use the same layout and immutable installation
contract. Their synthetic version separates local bytes from a published
version with the same source manifest version; changing any package file
creates a new fixed snapshot on the next daemon start.

Installation persistence follows daemon layering. `biz/agentextension` owns
the installation record contract; `service/agentextension` owns release
verification, package promotion, activation, and reconciliation; the narrow
`data/agentextension` installation adapter alone derives `agent/extensions`
paths and reads or atomically replaces `installation.json` and `active.json`.
Service code must not reconstruct the daemon state root.

The active record registers a system Agent Target with an
`agent_extension` launch reference fixed to `<agentKey>@<version>`. The
Target carries the package icon, optional mask icon, and optional home hero
image as data URLs, so renderer code does not add presentation assets or
provider branches for every extension. Package `icon` is the colored identity
reused by the provider rail, conversation identity, Message Center, and
mentions; optional package `maskIcon` is the mask-safe glyph for conversation
rows. All assets originate in the verified package and remain pinned to the
active installation version.

At launch the runtime controller asks `AgentRuntimeResolver` for unknown
providers. The resolver verifies the fixed installation reference, evaluates
the declarative discovery profile, prefers a compatible local runtime, and
creates the generic standard ACP adapter. A candidate may add signed
`searchPaths` entries with `scope: "user"`; every path must be a bounded
relative path below the current user's home directory. Those paths are
prepended to the shared runtime-command environment, so the extension can
describe an official vendor install location without adding provider-specific
filesystem code to `tuttid`. It never loads JavaScript, React, Go plugins, or
native modules from the extension.

The generic adapter applies declarative tool aliases before canonical activity
normalization and maps composer permission semantics onto runtime permission
IDs. Standard ACP content diffs continue through the shared ACP diff
normalizer, so Gemini and future extensions do not add provider branches to
AgentGUI. Both standard ACP `models` state and legacy `configOptions` are
normalized into the shared composer model descriptor; the catalog remains
runtime-reported instead of being hardcoded for an extension provider. A
prompt-free composer discovery session runs in the normalized selected project
scope. When no project is selected, it uses the daemon-owned discovery directory
under `<state>/agent/discovery/<provider>`, because standard ACP session creation
requires a concrete working directory.

### Spawn Settings And ACP Workflow Modes

Composer profile v1 has an optional, closed `launchSettings.permission`
declaration for agents whose permission tier is fixed when the process starts.
It accepts only the `${permissionMode}` placeholder as one complete discovery
`launchArgs` element, requires exactly one occurrence, and requires exactly one
unique runtime value for each Tutti semantic: `ask-before-write`, `auto`, and
`full-access`. The default semantic is fixed to `ask-before-write`. Empty
values, unknown or combined placeholders, unknown semantics, duplicate or
ambiguous values, and shell syntax fail installation validation. Expansion is
an argv-element replacement; it never invokes a shell or weakens the existing
runtime command validation.

Spawn-time permission is not an ACP workflow mode. The selected permission is
captured by conversation creation and changing it requires a new session. The
adapter does not send `session/set_mode` for that permission. An extension may
separately declare `workflowModes.plan.enabledRuntimeId` and
`disabledRuntimeId`; the shared Plan switch and `/plan` then send those two
validated values through standard `session/set_mode`. An agent whose Plan mode
exists only as a launch-time permission may additionally declare
`updateStrategy: "restart-with-launch-permission"`. For that strategy the
adapter replaces only the ACP process, loads the same provider session, uses the
enabled runtime ID while Plan is active, and restores the conversation's fixed
permission runtime value when Plan is disabled. A failed restart leaves the
previous live process and canonical settings unchanged. Profiles without these
optional declarations retain their existing ACP session-mode/config-option
behavior.

Composer profile v1 may also opt in to
`setModel.reasoningEffortMeta`. For that profile, the standard ACP
`SessionModelState.models.availableModels` entries are the only model and
reasoning catalog. Tutti preserves `supportsReasoningEffort`,
`reasoningEffort`, `reasoningEfforts` (including runtime labels and
descriptions), and `supportsImageInput`, whether supplied as supported model
fields or in model `_meta`. The daemon projects those facts through typed
composer options and `reasoningOptionsByModel`; AgentGUI therefore changes the
reasoning selector when the selected model changes. Unsupported models carry
an authoritative empty profile. A model or reasoning update uses standard
`session/set_model`; the validated current effort is added as
`_meta.reasoningEffort` only for a model that advertises reasoning support.
The established standard ACP config-option reasoning path remains unchanged
for profiles that do not opt in.

Slash-command narrowing remains declarative. A future extension can mark its
signed command catalog authoritative and allow only shared commands such as
`compact`, `status`, and `plan`; runtime-private commands are then removed
before composer projection. Image blocks, tool calls, permission requests,
cancel, resume/load, skills roots, and the client-provided standard ACP MCP
array continue through the generic adapter. The current Tutti session-create
contract supplies an empty MCP array and does not manage an agent's private MCP
configuration; adding a non-empty product-level MCP input is a separate Host
contract change.

Extension composer controls stay runtime-owned after the model list is
discovered. `tuttid` selects the newest context only within the exact workspace,
normalized project, Agent Target, fixed installation, and request-settings
scope. It may use an exact live or pinned persisted context, or a single-flight
hidden discovery result, to project only the model, permission, and reasoning
fields identified by the signed composer `configOptions.acpOptionId` references,
plus `availableCommands` into the slash-command catalog. The same signed option
IDs drive standard ACP startup and live setting writes; legacy top-level model
and permission source declarations map to `model`, `mode`, and the established
`reasoning_effort` alias. Persisted
runtime context is an internal recovery input only: the public composer response
publishes commands and per-model reasoning profiles through typed
`commands` and `reasoningOptionsByModel` fields. Those typed fields are
authoritative for desktop and AgentGUI projections; `runtimeContext` remains
opaque legacy/diagnostic data and is not an expansion seam for composer
capabilities. Legacy persisted contexts without the fixed installation and
profile identity are not eligible for reuse. Hidden extension discovery is
prompt-free and is closed immediately after success, start/terminal failure,
cancellation, or timeout. The standard ACP adapter canonicalizes
provider-native reasoning option ids such as `thought_level` or `effort` to
Tutti's `reasoning_effort` before they reach service or GUI projections, while
retaining the original runtime id for ACP writes. Unknown provider-native
options remain intact in the opaque runtime context; this does not imply a
generic AgentGUI control for every unknown option.

Signed composer profiles may narrow the provider-advertised slash-command
catalog and attach shared command effects such as submit-immediate, show-status,
activate-goal-mode, and toggle-plan-mode. `tuttid` applies that declarative
policy before returning composer options, so extension commands can reuse the
shared AgentGUI slash-command behavior without a provider-name branch. Signed
capability profiles may declare canonical GUI capabilities such as `compact`
and `planMode`. A declaration becomes effective only when current ACP runtime
facts and host support also establish it. The closed, signed
`workflowModes.plan` enabled/disabled ID pair is itself sufficient runtime
contract evidence for `planMode`, including agents that implement
`session/set_mode` without advertising a mode catalog from `session/new`.
For the launch-restart strategy, the same evidence is combined with the closed
spawn-permission declaration; the Plan runtime value must be distinct from all
three permission values.
Duplicates are removed, and unknown
extension-local capability keys remain package metadata rather than entering
the Agent Activity capability contract.

Extension-owned provider identities remain open metadata after an Agent Target
authorizes the launch. The shared provider registry validates their canonical
shape before activity events are created, so turn lifecycle and message events
retain identities such as `acp:example`; runtime authority still comes only
from the fixed `agent_extension` Target reference.

The standard ACP adapter stamps each turn transition with a sequenced,
adapter-origin lifecycle snapshot. Reporters and GUI consumers copy that
provider-independent snapshot, so completed, failed, and canceled extension
turns clear their active turn reference without requiring the extension
provider to be added to the built-in event projection catalog.

The current runtime adapter registry is still keyed by open provider ID for the
daemon lifetime. A cached generic adapter now fails closed when the requested
Target or fixed installation differs, while composer-context reuse uses the
full scope above. Sessions persist `agentTargetId` and resume re-derives the
extension installation from that Target. A composite session-pinned
runtime/profile fingerprint remains required before automatic extension
upgrades; until then, sources remain feature-gated and releases are activated
deliberately.

## Target-managed Runtime Setup

The daemon exposes Target-scoped setup resources at
`GET /v1/workspaces/{workspaceID}/agent-targets/{agentTargetID}/setup` and
`POST /v1/workspaces/{workspaceID}/agent-targets/{agentTargetID}/setup/install`
or `/setup/authenticate`. Setup never requires a selected project. Install
submission supplies only the daemon-issued plan digest and a client action ID.
`tuttid` resolves the workspace, enabled Agent Target, fixed extension
installation, and verified package manifest before deriving the runner argv,
exact package identity, install root, executable, launch arguments, and SHA-256
plan digest. Renderer input cannot replace any execution field.

Runtime roots use
`~/.local/share/tutti/agent-runtimes/<agentKey>/<runtimeIdentity>`, where
`runtimeIdentity` is derived from the runtime contract: Agent key, runtime
kind, platform, install runner and argv, exact package identity, launch
executable and args, and discovery profile. Extension metadata changes such as
localized copy or presentation assets do not force a reinstall when this
runtime contract is unchanged. This stable user-local root is shared by
development and production; daemon state keeps only setup action metadata.
`${platform}` resolves to Go's `<GOOS>-<GOARCH>` pair. Plan digests still bind
the Target and fixed extension installation in addition to the runtime
identity, platform, and complete resolved command, so one managed runtime is
reused across workspaces while setup actions remain tied to the exact Target
installation that the user confirmed. Every install action recomputes the plan
and compares its digest before creating files or processes.

The signed release is authoritative for runtime commands. Tutti persists both
the complete signed release record (preserving its signed JSON shape) and the
exact signed ZIP beside the extracted package. Every remote-package load
reverifies the Ed25519 signature against the configured source key, checks the
ZIP's signed SHA-256 and size, derives a
canonical content identity directly from those signed ZIP bytes, and compares
that identity and complete manifest with the active package. The copied manifest
and digest in `installation.json` are metadata and cannot redefine authority. A
same-version package directory whose content or authority differs is rejected
during load and atomically replaced only after a newly downloaded signed
artifact has been verified. Local development snapshots remain explicitly
content-addressed and are not interpreted as signed releases.

Remote manifest-v2 npm, pnpm, and uv installations created before persisted
signed-package authority remain readable offline through a closed legacy path.
That path requires an installation-v1 record with no release digest/size, no
persisted signed-release files, no binary artifacts, and no user-command
publication override. Tutti validates the complete package and manifest twice
around a canonical content fingerprint, then atomically records that fingerprint
in the legacy installation record. Later loads require the exact migrated
snapshot. Partial signed-authority state never falls back to legacy validation,
and legacy packages are redownloaded into signed authority when their source is
reachable rather than being reinterpreted as a signed installation.

Setup probes a compatible executable from signed user-relative search paths and
the shared daemon runtime PATH first. A compatible local runtime wins even when
a managed runtime exists. The desktop daemon does not source interactive shell
startup files such as `.zshrc`; vendor install locations outside its process
PATH belong in extension metadata, not provider-specific core code. Otherwise,
the installer runs manifest-owned argv directly in a private staging root beside
the fixed user-local installation; it does not invoke a shell or mutate any
project package manifest, lockfile, `node_modules`, or global package state.
Environment inheritance is allowlisted. Runner CWD and package-manager
cache/config live in a Tutti-managed scratch directory under that same
user-local runtime root. Tutti rejects symlinks in every existing ancestor of
the configured managed root. Staging, scratch, replacement, rollback, and final
activation use no-follow directory handles and relative directory operations;
the held handles are compared with their path identities before each boundary
on Unix. Activation metadata is written atomically relative to the held staging
descriptor, so replacing the staging pathname or placing a link at the metadata
name cannot redirect a write. Windows retains the established package-manager
staging and activation path for npm, pnpm, and uv runtimes; raw binary runtimes
remain fail-closed there until an equivalent no-follow activation implementation
is available.

For package-manager runtimes, `tuttid` resolves a regular executable inside
staging. A v2 manifest may instead set `runtime.install.runner` to `binary` and
provide a bounded `artifacts` catalog. Every entry is a raw `executable` pinned
by exact `<GOOS>-<GOARCH>` platform, semantic version, HTTPS URL, lowercase
SHA-256, byte size, and an `official-release` HTTPS provenance URL. Unsupported
platforms have no fallback and fail before download. The selected artifact is
streamed directly into the private staging root with exclusive creation and a
hard byte limit; Tutti verifies response transport, size, digest, executable
mode, and native Mach-O/ELF/PE platform identity. It never invokes an upstream
installer, shell, archive extractor, or PATH/rc mutation for this runtime kind.

For both install kinds, Tutti fingerprints the ordinary in-root executable,
runs the discovery profile's version check, then performs ACP `initialize` and
`session/new`. A binary runtime must report the exact artifact version, not
merely satisfy the local-discovery compatibility range. Binary version probes
start from the same verified descriptor on Linux or daemon-private immutable
snapshot on macOS as the final ACP process; the replaceable managed pathname is
never executed after an earlier fingerprint check. Fingerprints are rechecked
after ACP process boundaries and again after the atomic staging rename.
Authentication failures produce `auth_required`; protocol or runtime failures
fail the action. Successful and auth-required runtimes receive an
`activation.json` record. Symlinked package-manager bin shims are resolved to an
ordinary in-root file before activation and launch.

Binary replacement uses `<runtimeIdentity>.previous` as its only durable
intermediate state. Before activation removes any existing backup, and before
resolution trusts an active root, Tutti resolves an interrupted replacement.
If the active root matches the current installation identity and exact signed
artifact, it remains authoritative and the backup may be removed. If the active
root is absent or invalid, the backup is promoted only after its activation
identity, executable path, SHA-256, size, executable mode, and native platform
all match the current signed artifact; the held directory is checked again
after the rename. An invalid backup is never adopted and, when no verified
active root exists, is preserved for diagnosis. Thus interruption after either
replacement rename converges on the verified old or verified new runtime
without silently discarding the active runtime.

By default, successful activation also publishes the manifest launch
executable's basename at `~/.local/bin/<agent-command>`. The user entry is a
Tutti-owned symlink to
`~/.local/share/tutti/agent-runtimes/<agentKey>/bin/<agent-command>`; that
stable per-Agent link points to the executable in the fixed runtime root and is
atomically repointed on upgrade. A pre-existing regular file or foreign symlink
at either entry is never overwritten. Feature disablement and daemon shutdown
do not remove a published command, so it remains usable outside Tutti while the
managed runtime files remain installed.

The optional v2 `runtime.launch.publishUserCommand` field may be `false` for a
runtime that should be private to AgentGUI. Absence preserves publication for
every existing manifest. An opted-out runtime launches the verified fixed
executable inside `installRoot` and neither creates nor verifies the two
publication links. A pre-existing regular file or foreign symlink at the user
command path is therefore ignored and cannot prevent managed activation; Tutti
still never overwrites, removes, or repoints that entry.

Discovery skips this two-link managed entry when probing PATH, then resolves it
through the managed activation record. It therefore remains `source=managed`
and retains fingerprint verification instead of being mistaken for an
independent local installation. Both links are activation integrity: a missing,
foreign, broken, or unexpectedly repointed entry produces
`runtime_integrity_failed` and an explicit reinstall plan. Existing
extension-version roots may be adopted into the runtime-identity root only when
their Tutti activation record, package identity, executable fingerprint, and
current discovery version check all match. Binary runtimes additionally require
the executable SHA-256 and byte size to match the artifact in the current signed
manifest before adoption; otherwise the candidate is ignored and the user
receives an explicit reinstall plan. Candidate enumeration, activation-record
reads and replacement, rename, rollback, and recursive cleanup operate relative
to held no-follow directory descriptors on Unix. Binary executable identity is
re-established inside the descriptor/snapshot version launcher before any
candidate can execute, and is checked again around activation-record update and
adoption rename.

Normal resolution also opens the active runtime-identity root relative to the
held workspace descriptor on every attempt, even when no recovery backup is
present. Activation metadata and executable bytes are read relative to that
no-follow root handle and the handle's path identity is checked around the
version probe. A file or symlink occupying the active-root name is rejected as
an integrity failure; resolution never follows it or adopts its target.

The managed-runtime activation record persists the resolved executable's
runtime identity, package identity, SHA-256, and byte size. Every
managed-runtime resolution recomputes both fingerprint fields before the
version or ACP probe, and recomputes them again after the version probe. Binary
runtimes also compare the bytes with the current signed artifact SHA-256 and
size and revalidate the native platform on every resolution. A replacement, an
artifact from superseded signed metadata, or even a replacement reporting the
same compatible version is rejected with `runtime_integrity_failed` and returns
the exact reinstall plan.

For a managed binary, that expected SHA-256 and size are also carried through
the generic Standard ACP adapter into the final process specification. Linux
starts the verified open descriptor directly. macOS copies that descriptor to
a freshly created daemon-private snapshot, verifies it, marks both the file and
directory immutable and non-writable, starts it, and removes the snapshot
immediately after process start. The later
process boundary therefore never resolves the replaceable managed-runtime
pathname after trusting an earlier fingerprint.

An auth-required snapshot includes normalized methods from the fresh ACP
initialize response. Authentication submission accepts only the advertised
method ID and client action ID. The daemon initializes a new
process, revalidates the method, calls ACP `authenticate` on that process, then
requires `session/new` to succeed. Only that result produces `ready`; methods
being advertised is never itself an auth verdict. Authentication actions are
durable and never persist credentials.

An ACP `authenticate` result may expose non-secret account identity through a
namespaced `_meta` entry ending in `/userinfo`. Setup normalizes only the user
ID, display name, organization, and selected auth method; it discards all other
metadata. A successful authentication action persists that identity with its
private action record so later ready snapshots can show the signed-in account
without repeating authentication or storing credentials.

ACP runtimes may still accept `authenticate` and `session/new` before a real
request touches provider credentials. The Agent runtime therefore feeds a
failed formal-session authentication outcome back into the shared provider
auth invalidation store. A later Target setup probe overrides an otherwise
ready ACP probe with `auth_required` until an explicit re-authentication
succeeds or a formal request completes successfully. This is outcome feedback,
not a synthetic prompt probe during setup.

Install actions are idempotent by Target/fixed-installation scope and client action ID. Their
phase and status are persisted under daemon state. A queued/running record not
owned by the current daemon process is recovered as `interrupted`, allowing an
explicit retry. Setup probes use a daemon-owned discovery CWD. Formal sessions
pass their real CWD only to ACP and launch-argument expansion; runtime storage
remains project-neutral.

Setup action ownership follows the daemon layers. `biz/agentextension` defines
the action and scope values; `service/agentextension` owns transitions and
depends on `SetupActionStore` plus `SetupDiscoveryDirectory`; the
`data/agentextension` file adapters alone derive paths and perform filesystem
I/O. Action JSON is scope-validated, decoded strictly, and replaced atomically
with private directory/file permissions. Each setup operation resolves its
discovery root once through that directory adapter, then passes the resolved
root through runtime resolution, installation verification, probing, and
authentication instead of recomputing or creating it in those workflows.

After a request accepts an install or authentication action, work no longer
depends on that request context. It runs under the setup service's
daemon-owned worker context. Daemon shutdown closes setup before the runtime
and state store, refuses new actions, cancels and waits for accepted workers,
then persists cancellation as `interrupted`. Persistence failures are returned
by setup close; they are not discarded as background goroutine errors.

AgentGUI recognizes target-runtime setup metadata on the exact Target. Its
shared panel owns explicit confirmation and plan presentation,
progress polling, runtime-advertised auth method selection, login progress, and
retry. A failed or interrupted install keeps its durable error visible while
the retained plan can start a new action with a new client action ID; refreshing
the old action is not an installation retry. Background action polling preserves the established detection result
instead of restarting the detection presentation on every snapshot request.
Failed explicit authentication keeps the provider's ACP error on the durable
action and presents it beside the localized failure summary while leaving the
auth method available for an explicit retry. Target selection never opens the dialog. Initial detection remains
non-modal and blocks the empty-home composer with a checking gate; a non-ready
snapshot shows an inline setup affordance, and only an explicit click opens the
dialog. The selected Target's config menu also exposes this same dialog after
setup is ready, including auth-method selection and explicit re-authentication.
The empty-home gate and config-menu host reuse one Target-scoped watch rather
than starting duplicate polls. Closing remains controlled, and the Dialog
stays mounted through ready transitions so its pointer/scroll lock can clean
up. Active conversations are never replaced by setup UI.

## Feature Gate And Failure Behavior

Source defaults come from generated configuration. Desktop Developer settings
override them through generic `agent.extension.<key>` feature flags. A
preference write reconciles only when an extension source changes effective
activation, then the desktop refreshes its Agent Target catalog. The daemon
keeps this source-key driven; it has no Gemini or CodeBuddy branch.

Disabled sources do not perform network requests and their system Target is
removed. When an enabled source cannot reach its index, a previously verified
active installation remains available. If no verified installation exists,
the source is not registered and `tuttid` logs one
`agent_extension.reconcile_failed` record with a JSON payload.

Composite session-pinned adapter cache keys, richer tool/event profiles, and
removal of remaining built-in catalogs remain migration work. Composer
discovery is not setup state and does not infer
installation or authentication readiness. Extensions use either a compatible
local runtime or an explicitly confirmed Target-managed runtime; `tuttid`
never installs into a user project.

## Declarative Grok Compatibility

The generated source registry contains a default-off `grok` entry using key ID
`tutti-grok-release-v1` and the approved Ed25519 public key. Enabling remains a
generic `agent.extension.grok` feature-flag decision; no Grok provider or
renderer branch exists.

The separate Grok extension is expected to declare official CLI `0.2.103` for
`darwin-arm64` as a binary artifact with URL
`https://x.ai/cli/grok-0.2.103-macos-aarch64`, size `121600480`, SHA-256
`1be9de92f31566f2d38992125f902220b022f4f1e3fb7330532a0513d1d6f0f2`, and
official provenance `https://x.ai/cli/install.sh`. Its launch executable is
`${installRoot}/grok`, `publishUserCommand` is `false`, and managed launch args
are exactly `--no-auto-update --permission-mode ${permissionMode} agent stdio`.
They remain extension-owned declarative data. Only Apple Silicon is initially
listed; the generic catalog can add independently pinned platform entries in a
later signed extension release.

For Grok CLI 0.2.103, the spawn-time permission values are `default` for
ask-before-write, `auto` for automatic operation, and `bypassPermissions` for
full access. These are CLI permission values, not ACP workflow mode IDs; Plan
continues to use the independent `plan` / `default` `session/set_mode` pair.

## Opt-in Real Grok ACP Smoke

The generic adapter has an explicit local smoke for an already installed and
authenticated official Grok CLI:

```sh
TUTTI_REAL_GROK_ACP_SMOKE=1 \
TUTTI_GROK_BIN=/absolute/path/to/grok \
go test ./packages/agent/daemon/runtime -run TestRealGrokACPInitializeSmoke -count=1
```

It is skipped by default, reads no user authentication state in CI, creates no
ACP session, and sends no prompt. When explicitly enabled it verifies the
executable/version, performs standard ACP `initialize`, checks that the
initialize model state has an available and current model, then closes the
process. The fake ACP tests separately verify the exact declared spawn argv and
all permission tiers; keeping those checks separate lets the smoke remain
non-billable even when a CLI release makes `session/new` contact the service.

This support does not add a Grok provider, icon, executable wrapper, credential
persistence, private authentication protocol, headless/TSH integration,
automatic CLI updates, or private `x.ai/*` operations. End-to-end AgentGUI
visibility still requires separately reviewed and signed external extension
bytes; the default-off source alone does not make a release available.
