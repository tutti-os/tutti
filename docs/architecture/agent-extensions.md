# Agent Extensions

Status: current implemented architecture

Agent Extensions let independently released ACP agents integrate with Tutti
without adding provider-specific executable code to this repository. An
extension is declarative data: a manifest,
discovery/tool/capability/composer/authentication/account-usage profiles, locale
resources, and static assets.

## Trust And Distribution

Configured sources live in `config/tutti.defaults.json`. Each source pins an
agent key, exact Extension version, HTTPS `versions.json` URL, default
activation state, signing key ID, and Ed25519 public key. `tuttid` accepts only
that client-pinned release when it remains active and compatible and its
canonical release JSON signature, artifact SHA-256, byte size, manifest
identity, and package contents all validate. Publishing a newer release to the
remote index does not change an already shipped Tutti client; adopting it
requires a Tutti release that updates the source's `pinnedVersion`.

During a versioned metadata-path rollout, a source may declare ordered fallback
index URLs. Fallback is permitted only when a higher-priority index cannot be
fetched, such as before the new CloudFront path has been published. Once an
index is fetched, its JSON shape, agent identity, compatibility, active or
withdrawn state, and selected release signature are authoritative and fail
closed; a legacy index must never revive a release rejected by that authority.
Remove rollout fallbacks after the new metadata path is published and the
supporting Tutti version has propagated.

`minTuttiVersion` is evaluated only after the complete versions document has
been decoded. It therefore cannot protect an older strict decoder from a new
field inside an embedded manifest. A release that extends the manifest wire
shape must publish `versions.json` under a new versioned metadata path, leave
the previous index unchanged for older Tutti builds, and switch the configured
source URL only in a Tutti release that understands the new shape. Immutable
artifacts may remain under the Agent's existing release path because older
clients cannot select them through their frozen metadata index and exact
version pin.

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
directory. Every daemon start with an explicit local override synchronously
snapshots and validates the currently configured directory before serving the
Agent Target. A cached `+local` snapshot is never an offline fallback for a
missing or invalid development directory; reconciliation removes the stale
Target while preserving its enabled preference when a valid new snapshot is
registered. Removing the override requires the signed remote source again.
Production ignores this override and continues to require the signed HTTPS
release path.

Development clients may use synthetic or zero application versions while the
desktop is running from source. Remote extension selection still requires the
configured active pin, signed release, and declared host capabilities; the
release's `minTuttiVersion` gate is enforced only for packaged production
clients, whose version is a release compatibility claim.

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
Service code must not reconstruct the daemon state root. Managed-first Runtime
selection is derived from the running client's exact source pin and is not an
independent durable installation preference. Readers accept and discard the
legacy `preferManagedRuntime` field so strict decoding remains compatible with
records written during the initial rollout.

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
the declarative discovery profile, and creates the generic standard ACP
adapter. Client-pinned remote installations prefer their matching
Tutti-managed runtime, with a compatible local runtime as a temporary fallback
while automatic convergence is pending. Local development snapshots retain
local-first discovery. A candidate may add signed
`searchPaths` entries with `scope: "user"`; every path must be a bounded
relative path below the current user's home directory. Those paths are
prepended to the shared runtime-command environment, so the extension can
describe an official vendor install location without adding provider-specific
filesystem code to `tuttid`. It never loads JavaScript, React, Go plugins, or
native modules from the extension.

Composer skill roots remain declarative runtime inputs. Workspace roots must be
safe relative paths at both installation validation and service consumption
boundaries; absolute and parent-traversing paths are ignored before runtime
preparation or discovery. Tutti materializes only its managed skills into those
roots and replaces the same managed directories on repeated preparation, so a
persistent workspace cannot accumulate suffixed copies. User-owned colliding
directories are never replaced.

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

### Provider-owned account usage

An Extension may declare the optional `accountUsage` profile with schema
`tutti.agent.account-usage-probe.v1`. The profile pins one exact npm or pnpm
companion package, `node-script` entry below `${installRoot}`, fixed argv, and a
bounded timeout. The Extension ZIP remains data-only: the companion is a
separately published Provider-owned artifact with its own runtime identity,
install root, activation, and verification lifecycle. It is never part of the
primary ACP install command, runtime identity, activation, resolution, or
adoption. A companion download, install, verification, or activation failure
therefore leaves the Agent ready and only makes the account-usage endpoint
return `runtime_unavailable`; a status read never downloads code. The
independent reconciler persists a diagnostic-light failure record and its next
bounded retry time, so daemon restart preserves backoff. Recovery deletes the
record.

Before every probe, tuttid verifies the fixed host Node interpreter and the
ordinary in-root CommonJS script independently. The script is supplied to Node
as the already verified bytes instead of executing an npm `.cmd`/shell shim or
reopening the mutable script pathname. This is the same contract on Windows,
macOS, and Linux. Fingerprinting and snapshot construction observe the probe
context. Windows keeps one content-addressed, verified `node.exe` snapshot in
daemon-private state and holds it against writes while probes reuse it; after a
daemon restart the snapshot is verified once instead of copying the source
interpreter again.

Local Extension development may replace that managed companion with one
explicit executable through
`TUTTI_AGENT_EXTENSION_<KEY>_ACCOUNT_USAGE_EXECUTABLE`. This is accepted only
for a development-mode installation with local-package provenance; the path
must be an absolute, ordinary, non-symlinked, fingerprint-stable JavaScript
file. The Node interpreter is still resolved and verified separately.
Production ignores the override and continues to require the exact companion
package pinned by the signed profile.

The companion owns all Provider-private behavior, including config and
credential lookup, OAuth issuer-to-usage-origin binding, endpoint paths,
refresh timing, and response conversion. It prints only one bounded versioned
JSON result to stdout; stderr is discarded at the process boundary. `tuttid`
strictly decodes a closed `available | unsupported | error` result, attaches
the exact Agent Target and provider identity, and exposes only stable error
codes and normalized quota fields. Unknown fields, schemas, enums, malformed
numbers, empty subscription success, and trailing output fail closed. Desktop
and AgentGUI never select this capability by provider name and never receive
tokens, configured endpoints, paths, raw response bodies, or Provider error
text.

The normalized account-usage v2 snapshot separates billing identity from quota
completeness. `billingMode` is `api`, `subscription`, `coding_plan`, or
`provider_account`; `quotaState` is `complete`, `unavailable`, or
`not_applicable`. Only `complete` may carry quota rows. `api` is explicitly
`not_applicable`; a recognized plan or Provider account whose complete balance
cannot be proven remains `unavailable` without an authoritative empty or
partial balance. Exact balances use Provider-neutral amount/unit fields such as
`credits`, while tokens, account IDs, and raw package records remain inside the
companion. Tutti accepts the original v1 helper result for existing Extensions,
normalizes it to v2 at the daemon boundary, and requires new companions to emit
v2 whenever they need these completeness or exact-amount semantics.

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

Standard ACP process recycling is capability-driven rather than extension-name
driven. When the live `initialize` response advertises `session/load` or
`session/resume`, the shared 30-minute idle reaper may close only that ACP
transport and CLI process while retaining the Tutti session and provider
session id. The next execution launches a new process and restores the provider
session. The reaper does not send `session/close`, skips providers without a
proven restore method, and treats pending interactive requests as busy.

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
cancellation, or timeout. When discovery completes after the caller's bounded
wait has returned, tuttid publishes the existing model-catalog refresh signal;
active composer consumers then reload the newly cached catalog instead of
requiring a new conversation. The selected model is not part of the discovery
cache identity because the hidden discovery session does not receive a model;
acknowledging its advertised default must continue to address the same catalog.
The standard ACP adapter canonicalizes
provider-native reasoning option ids such as `thought_level` or `effort` to
Tutti's `reasoning_effort` before they reach service or GUI projections, while
retaining the original runtime id for ACP writes. Unknown provider-native
options remain intact in the opaque runtime context; this does not imply a
generic AgentGUI control for every unknown option.

Model consumption metadata follows the same adapter-first rule without making
provider prose globally meaningful. A verified Extension may opt its model
config reference into the closed
`descriptionMetadataFormat: "credit-consumption-multiplier-v1"` declaration.
Only then does the standard ACP adapter remove a standalone `xN credits`
description segment and project its numeric token as the typed
`consumptionMultiplier` model field. Unknown formats fail package validation
and adapter construction; profiles without the declaration preserve the full
description. The daemon API and activity adapter preserve the typed field, and
AgentGUI renders it without parsing provider prose or branching on a provider
name.

Signed composer profiles may narrow the provider-advertised slash-command
catalog and attach shared command effects such as submit-immediate, show-status,
activate-goal-mode, and toggle-plan-mode. `tuttid` applies that declarative
policy before returning composer options, so extension commands can reuse the
shared AgentGUI slash-command behavior without a provider-name branch. Signed
profiles may also set
`skills.runtimeCommandProjection: "unlisted-as-skills"` alongside an
authoritative slash-command catalog. In that mode, runtime-advertised entries
outside the signed core-command list are projected through the typed `skills`
field with their exact slash trigger and runtime description. AgentGUI then
renders separate command, capability, and skill groups without a
provider-name branch; known Tutti-injected routing skills remain hidden from
the composer picker.
Signed capability profiles may declare canonical GUI capabilities such as
`compact` and `planMode`. A declaration becomes effective only when current ACP
runtime facts and host support also establish it. The closed, signed
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
runtime/profile fingerprint remains required before any future automatic
in-session migration. The daemon does not activate a newly published remote
Extension dynamically: source activation is controlled by the Tutti client's
exact version pins, and existing sessions stay pinned to their recorded Target
installation.

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

After a client-pinned remote Extension is activated, a daemon-owned background
reconciler automatically installs the exact Runtime declared by that signed
Extension into Tutti's private runtime root. It runs once at startup, wakes
after source refresh or activation, and tracks retry state independently for
each Target. Transient installation failures use exponential backoff capped at
30 minutes without rechecking settled Targets. Permanent contract, platform,
or user-command ownership conflicts wait for a source or preference wake, or
an explicit setup action, instead of retrying on a timer. It never writes to or replaces a
user-owned PATH executable, and local development snapshots are excluded. The
Target-scoped setup endpoints remain the observable repair and authentication
surface; automatic convergence reuses the same verified install pipeline as an
explicit setup action.

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
the shared daemon runtime PATH. Local development snapshots remain local-first.
For a client-pinned remote installation, an already verified managed Runtime
wins; a compatible local Runtime is used only until automatic managed-runtime
convergence succeeds. The desktop daemon does not source interactive shell
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

The `uv` runner does not follow the stage-then-rename model: uv tool
environments embed absolute paths (bin symlinks, venv shebangs, `pyvenv.cfg`)
and cannot survive the activation rename. uv runtimes install in place. Tutti
first resolves a Tutti-managed uv toolchain — a pinned uv version declared in
`config/tutti.defaults.json` (`agentRuntimeTools.uv`) with per-platform
archives, SHA-256, and byte sizes — downloaded with the same streaming
verification as binary artifacts, extracted as a single pinned member, and
cached under `~/.local/share/tutti/agent-runtimes/_tools/uv/<platform>/<version>`.
The user machine needs no preinstalled uv or Python. The install invokes the
managed uv executable by absolute path, while also prepending its directory to
`PATH` for uv subprocesses. Confinement variables point into the final root:
`UV_TOOL_DIR=<installRoot>/tools`, `UV_TOOL_BIN_DIR=<installRoot>/bin`,
`UV_PYTHON_INSTALL_DIR=<installRoot>/python`, a shared content-addressed
`UV_CACHE_DIR` under `_tools/uv/cache`, and `UV_NO_CONFIG=1`. Tutti also sets
`UV_PYTHON=3.12` and `UV_MANAGED_PYTHON=1`, so package resolution and execution
use a Tutti-owned Python 3.12 instead of whichever system Python happens to
appear on the daemon PATH. A previously committed root (valid
`activation.json`) is moved to `<runtimeIdentity>.previous` before installing
and restored on any failure; an uncommitted partial root is discarded, and a
missing root with a self-consistent backup (matching activation identity plus
executable fingerprint) is restored instead of reinstalling. `activation.json`
remains the commit marker, and the fingerprint/version/ACP-probe verification
chain is unchanged.

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
executable's basename at `~/.local/bin/<agent-command>`. The user entry points
to `~/.local/share/tutti/agent-runtimes/<agentKey>/bin/<agent-command>`; that
stable per-Agent entry points to the executable in the fixed runtime root and
is atomically repointed on upgrade. Unix uses Tutti-owned symlinks for both
hops. Windows uses Tutti-owned `.cmd` launchers because ordinary desktop users
do not have file-symlink privilege; the launcher preserves arguments and the
child exit code. A pre-existing regular file, foreign symlink, or foreign
Windows launcher at either entry is never overwritten. Feature disablement and
daemon shutdown do not remove a published command, so it remains usable outside
Tutti while the managed runtime files remain installed.

The optional v2 `runtime.launch.publishUserCommand` field may be `false` for a
runtime that should be private to AgentGUI. Absence preserves publication for
every existing manifest. An opted-out runtime launches the verified fixed
executable inside `installRoot` and neither creates nor verifies the two
publication entries. A pre-existing regular file, foreign symlink, or foreign
Windows launcher at the user command path is therefore ignored and cannot
prevent managed activation; Tutti still never overwrites, removes, or repoints
that entry.

### Declarative Launch Environment

The optional v2 `runtime.launch.env` field is a bounded map from the target
process environment key to a host-owned reference. Values must use the exact
form `${env:TUTTI_*}`; Tutti resolves the referenced `TUTTI_*` variable at
launch time and omits the entry when the host variable is unset. Manifests
cannot read credentials or arbitrary environment variables, and they cannot
embed literal paths or secrets in the package. Provider-specific mappings
belong in the extension manifest, while the daemon only implements this
generic, allowlisted resolution. For example, a Kimi extension can declare
`KIMI_SHELL_PATH: "${env:TUTTI_MANAGED_POSIX_SHELL}"` without adding a Kimi
branch to `tuttid`.

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

A signed `authentication` profile may bind one runtime-advertised method ID to
a closed terminal command declaration. Authentication profile v1 supports
`type: "terminal"` with either `command.strategy: "runtime-subcommand"` and a
bounded, non-empty argv array, or `command.strategy: "runtime-slash-command"`
with exactly one safe slash-command name and a bounded literal `readyText`
marker. For a slash command, the daemon exposes the quoted runtime launch plus
one atomic typed startup action; it never exposes raw terminal input. The
Desktop terminal adapter validates the action, generates the leading `/`, and
submits it only after the matching terminal session emits the declared marker.
Startup failure terminates setup readiness monitoring instead of leaving a
background poll running. The extension cannot declare raw terminal input,
control characters, or shell source.

A declaration may also replace the advertised method's display name and
description with bounded presentation strings. Tutti applies those fields only
when the declaration ID and type match the fresh ACP method, so
provider-specific setup wording and commands remain in the extension package
instead of daemon code. For runtime subcommands, the daemon quotes every
projected argument before exposing the ready-to-run launch command.

Without a signed declaration, Tutti retains compatibility with provider
metadata: it reads top-level ACP `type`/`args` fields first and falls back to
`_meta["terminal-auth"]`. Methods of type `terminal` require an interactive
terminal that can never complete inside the headless setup process, so the
daemon rejects ACP `authenticate` for them immediately and lets the host surface
or launch the resolved command. The profile changes terminal presentation and
launch policy only; the fresh ACP initialize response remains authoritative for
which authentication methods are actually available.

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

## Activation And Failure Behavior

Source defaults come from generated configuration. A source with `enabled:
true` is a stable integration and is always reconciled; historical
`agent.extension.<key>` preference values no longer override it. Sources with
`enabled: false` remain Early Access integrations that Desktop settings can
activate through the generic `agent.extension.<key>` feature flag. A preference
write reconciles only when one of those opt-in sources changes effective
activation, then the desktop refreshes its Agent Target catalog. The daemon
keeps this source-key driven rather than branching on individual providers.

Disabled Early Access sources do not perform network requests and their system
Target is removed. When an active source cannot reach its index, a previously
verified active installation remains available. If no verified installation
exists, the source is not registered and `tuttid` logs one
`agent_extension.reconcile_failed` record with a JSON payload.

Daemon startup restores and verifies every active source's local active
installation before serving Agent Target reads. A remote installation is usable
only when its version equals the current client's exact source pin; an active
record from another client pin forces source reconciliation and fails closed if
that pinned release cannot be obtained. When every active source has a usable
local installation, release-index refresh runs in the background and does not
delay the daemon listener. If any enabled source has no usable local
installation, startup keeps the synchronous reconcile path so that a first
installation is registered before the daemon serves its initial Target
catalog. Preference-driven activation changes also remain synchronous. After
activation, managed Runtime convergence continues in the background and does
not delay the daemon listener.

Agent Target catalog reads continue to verify the installed extension package
and managed runtime integrity before reporting availability. Successful runtime
version probes are reused only while the resolved executable fingerprint,
version arguments, and constraint are unchanged. Concurrent reads share the
same in-flight probe. Failed probes are not cached, so repairing or installing a
runtime is visible on the next read. Runtime launch and setup keep their
authoritative integrity checks and do not trust catalog availability as launch
authorization.

Composite session-pinned adapter cache keys, richer tool/event profiles, and
removal of remaining built-in catalogs remain migration work. Composer
discovery is not setup state and does not infer
installation or authentication readiness. Client-pinned remote Extensions use
an automatically managed Runtime with compatible local fallback while it is
being installed; local development Extensions remain local-first. `tuttid`
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
