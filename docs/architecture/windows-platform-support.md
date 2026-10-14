# Windows Platform Support

This document defines how Tutti adds Microsoft Windows support without making
the product core depend on Windows implementations. It describes the current
architecture and promotion boundaries; command-level Workspace App rules live
in [Workspace App Runtime](../conventions/workspace-app-runtime.md), and release
mechanics live in [Desktop Release](../conventions/desktop-release.md).

`desktop-windows.md` describes Electron product windows. It is not the source of
truth for Microsoft Windows operating-system support.

## Goals And Current Status

The target is one product behavior across macOS and Windows, with operating
system differences behind capability interfaces. The current Windows target is
Windows 10/11 x64. Windows packaging remains Alpha-only and is not part of the
formal `latest` release path.

Current implementation and evidence:

| Area                     | Shared owner                                            | Windows boundary                                                              | Status                                                                                          |
| ------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Desktop daemon lifecycle | Electron main process                                   | packages `tuttid.exe` and injects native resource paths                       | Windows Alpha CI packages it                                                                    |
| Workspace Apps           | daemon app lifecycle, health, state, and events         | `AppShellAdapter` invokes the packaged managed POSIX shell                    | Onboarding fat package is exercised in Windows Alpha CI                                         |
| Terminal                 | terminal service and shared terminal contracts          | `TerminalProcessFactory` uses ConPTY                                          | focused adapter and daemon WebSocket tests run in Windows daemon-adapter and Alpha CI           |
| Agent processes          | provider-neutral agent/runtime services                 | build-tagged executable, command, process handling, and user PATH publication | focused Windows tests run in Agent adapter and Alpha CI                                         |
| Browser                  | browser service contract                                | focused Windows executable/profile path behavior                              | focused Windows tests exist; full browser E2E remains a promotion gate                          |
| Computer use             | computer service contract                               | Cua Driver 0.18.0 doctor/MCP boundary and owned daemon                        | focused Windows tests and opt-in MCP smoke exist; screenshot/input E2E remains a promotion gate |
| Files                    | workspace file APIs and portable Go filesystem behavior | add a narrow adapter only where Windows semantics differ                      | full Windows Files E2E remains a promotion gate                                                 |
| Release                  | desktop release policy                                  | Certum Authenticode-signed NSIS plus a separately gated Store AppX artifact   | signed Direct release automation exists; real-machine acceptance remains a promotion gate       |

Passing `windows-latest` CI proves the build and automated paths above. It does
not by itself prove the supported Windows 10 floor, installer UX, upgrade, or
uninstall behavior on real machines.

## Architecture Rules

Windows compatibility is a continuous repository requirement, not a feature
that is considered only when a task explicitly mentions Windows. Every behavior
change must assess its Windows impact. Changes involving paths, filesystems,
temporary storage, executables, commands, shells, environments, processes,
permissions, symlinks, sockets, packaging, or native dependencies are
platform-sensitive by default and require Windows and POSIX reasoning and
focused coverage.

Platform-neutral services depend on capabilities, not operating-system
implementations:

```text
Desktop package and composition
            |
            v
       tuttid common core
  lifecycle / API / state / DB / events
            |
            v
      capability interfaces
       /                 \
 Darwin implementations  Windows implementations
                          shell / ConPTY / process / paths
```

Apply these rules when adding another Windows capability or another operating
system:

1. Keep lifecycle, API contracts, persistence, health checks, and event
   publication in shared owners.
2. Define the smallest capability interface at the consumer boundary. The
   consumer must not import the native library or desktop packaging layout.
3. Select an implementation in the owning composition root or a small
   build-tagged factory. OS checks do not belong throughout business logic.
4. Keep portable behavior shared. Do not introduce `FooAdapter` merely because
   a module can run on multiple operating systems.
5. Group cohesive platform behavior. A platform does not need a separate file
   for every helper; split only where build constraints or genuinely different
   semantics require it.
6. Derive paths from injected roots and standard platform APIs. Do not hardcode
   drive letters, user directories, installation locations, or executable
   search results.
7. Treat every path crossing a process, RPC, JSON, environment, or provider
   boundary as a host path unless the contract explicitly declares a virtual
   namespace. Construct host paths with the platform path API, preserve the
   required absolute-path base such as `cwd`, and never send a POSIX-rooted
   literal such as `/tmp` or `/sandbox-tmp` to a Windows parser.
8. Resolve executables through the owning adapter. Account for `.exe`, `.cmd`,
   and `.ps1`, PATHEXT and PATH behavior, spaces and non-ASCII characters in
   paths, and Windows command-line quoting. Do not assemble shell command
   strings when an argv-based process API is available.
9. Tests for a platform-sensitive contract must exercise the receiving parser,
   process, or filesystem boundary on Windows where practical. A mock that only
   verifies emitted strings or serialized maps is insufficient evidence of
   Windows compatibility.

This is dependency inversion at the native boundary, not a requirement to
create parallel copies of each service.

### Workspace project identity and imported rail placement

Project paths have one display form and one comparison form; callers must not
compare raw strings when the path crosses a desktop/daemon boundary. The shared
user-project core normalizes slash direction and trailing separators, then
folds case only for Windows-shaped drive or UNC paths. POSIX paths remain
case-sensitive. On a Windows host, a single-root POSIX project path is an
explicit logical namespace: the Go rail store cleans it with POSIX semantics
and never rebases it onto the current drive. Native drive and UNC paths keep
Windows filesystem normalization. The rail store keeps the resulting canonical
path for display and derives a stable section key for persistence. Project
registration and deletion resolve an incoming path variant to the existing
stored row before applying the table's ordinary unique-path write guard, so no
second identity column is needed.

External session import can persist a session before its selected project is
registered. The import path therefore registers projects and repairs only
sessions carrying the durable `imported` marker in the same workspace SQLite
transaction. Startup migration `workspace_agent_activity_rail_v2` replays the
same repair for historical rows; ordinary conversations are not moved. This
uses existing APIs and tables—no new wire fields or database columns are
required.

## Workspace App Data Flow

Workspace Apps keep one manifest and one POSIX `bootstrap.sh` across platforms:

```text
App Center install
  -> validate and unpack one fat package
  -> AppRunner owns lifecycle and environment
  -> AppShellAdapter selects host invocation
  -> bootstrap.sh reads TUTTI_PLATFORM
  -> bin/windows-amd64/*.exe or bin/darwin-*/*
  -> health check
  -> state persistence and business events
```

On packaged Windows Desktop, the desktop vendors a pinned minimal POSIX shell
runtime, currently implemented with Bash, and injects its absolute path when
starting `tuttid.exe`. The Windows
`AppShellAdapter` invokes that Bash with profiles disabled and exposes its
managed command directory through `PATH`. Apps do not depend on Git for Windows
or WSL, and the manifest does not duplicate platform entrypoints.

Windows direct development uses the same managed runtime. The desktop `predev`
hook prepares `apps/desktop/build/managed-posix-shell`, and the Electron main
process resolves that runtime when it builds the daemon launch environment.
Therefore `pnpm dev` does not depend on a caller remembering a separate shell
export; the daemon still receives `TUTTI_MANAGED_POSIX_SHELL` before it starts.
Windows staging and E2E acceptance should continue to use the dedicated E2E
launcher because it also owns state isolation, cleanup, and readiness checks.

The package is fat because it contains every currently shipped platform
artifact. `TUTTI_PLATFORM` selects the artifact at runtime. Adding a future
platform key should add an artifact and build job, not another app lifecycle.

The desktop also resolves the packaged or development native `tutti.exe` at
composition time and passes its absolute path to `tuttid`. The Workspace App
runner exposes that executable as `TUTTI_CLI` together with the effective
`TUTTID_LISTENER_INFO_PATH`. Apps therefore launch the CLI without `cmd.exe`
or batch-file parsing. The user-facing `tutti.cmd` remains a terminal PATH shim;
it is not the Windows Workspace App execution contract.

## Native Adapter Boundaries

### Workspace App shell

`AppRunner` owns app lifecycle and depends on `AppShellAdapter`. The adapter
validates host script semantics, answers how to invoke a package script, and
returns the managed command directory that must be available. Production wiring
creates one platform adapter and injects it into App Center, AppRunner, and App
Factory; those consumers do not branch on the operating system. The reusable
packaged resource is named
`managed-posix-shell`; shell download, verification, and desktop resource
layout remain desktop packaging concerns. Other domains may reuse that resource
through their own narrow adapter, but must not depend on `AppShellAdapter` or
expand the Workspace App contract.

### Terminal

The terminal service depends on `TerminalProcessFactory` and `TerminalProcess`.
The factory supplies both the default `TerminalShellSpec` and process creation.
Unix PTY file descriptors stay on a Unix-private capability and are not part of
the shared process contract; Windows therefore does not provide a fake FD.
Unix PTY and Windows ConPTY libraries remain private to their implementations.
Session lifecycle, resize semantics, snapshots, WebSocket transport, and exit
events remain shared daemon behavior.

### Agent process execution

Agent installation and launch keep provider/product policy shared. Windows
command resolution, executable verification, npm launcher layout, and process
creation stay in the runtime command/process boundary. Managed npm installs use
the selected user executable directory (normally `%USERPROFILE%\.local\bin`)
as npm's Windows prefix, because Windows npm writes `.cmd`/`.ps1` launchers
directly under the prefix. After a successful managed install/update, the
daemon's narrow Windows user-path adapter idempotently appends that directory
to `HKCU\Environment\Path` and broadcasts `WM_SETTINGCHANGE`; it never
writes the machine-wide path or changes Unix/macOS shell profiles. Do not make
provider installers assemble shell command strings to handle Windows.
Fresh installs use `%USERPROFILE%\.local\bin`. The resolver also scans the
older `%USERPROFILE%\.local` npm prefix after the current directory, so an
existing verified package is reused and updated in place instead of creating a
second copy. After verification the daemon publishes the directory that owns
the selected launcher. It does not migrate or delete the legacy package.

Managed Agent Extensions and the provisioned Claude Code runtime use the same
`%USERPROFILE%\.local\bin` publication contract. Their versioned executables
stay under `%USERPROFILE%\.local\share\tutti\agent-runtimes`; a stable per-Agent
`.cmd` launcher and an optional user-level `.cmd` launcher form two verified
hops to the active executable. This avoids file-symlink privilege and keeps
versioned runtime directories out of `PATH`. Before publishing Claude, the
daemon scans the complete effective command search and preserves any
independently installed launcher. A later reconciliation removes an older
public launcher only when it still carries the Tutti marker and targets the
expected stable runtime hop. Removal first atomically quarantines the launcher,
then inspects the moved file; a concurrently replaced external launcher is
restored without overwriting a newer entry. The private hop remains active.
Successful publication surfaces user-PATH write failures, while skipped
publication never adds the directory to the current-user registry PATH.
Registry changes affect new processes only, so an already-open terminal must be
restarted before it can resolve a newly published command.

Portable Agent Extension manifests keep npm and pnpm launch executable names
extensionless. The Windows install-plan adapter resolves those names to the
actual `.cmd` launcher before verification, activation, version probing, and
launch; the structured command adapter invokes the launcher through `cmd.exe`.
Product and provider code must not append the suffix or assemble the shell
command itself.

Managed-runtime adoption must also release the verified source directory handle
before renaming that directory. After rename, reopen the promoted directory and
repeat the fingerprint/integrity check; rollback follows the same close-rename-
reopen order. Unix permits rename with the old handle open, but Windows rejects
it as a sharing violation.

Provider-owned account-usage helpers do not execute npm `.cmd` launchers or
copy JavaScript into a fake `.exe`. Their optional package is installed and
activated separately from the ACP runtime. The process boundary verifies the
fixed `node.exe` interpreter and the declared CommonJS script independently,
then feeds the verified script bytes to Node. Windows CI must exercise an
actual npm pack/install and account-usage probe in addition to native Go
executable verification; a companion failure may produce only
`runtime_unavailable`, never a not-installed Agent. Companion installation is a
daemon-owned reconciler with durable restart recovery and bounded retry backoff; setup
status reads never initiate its package download.
The first probe builds a content-addressed Node snapshot with context-aware
copy/hash. Later probes reuse the read-locked snapshot without copying or
hashing `node.exe` again; a restarted daemon verifies it once before reuse.

Extension session-home preparation keeps its source declaration portable. An
explicit source environment variable wins; otherwise the Windows adapter maps a
leading-dot top-level directory to the native user cache root
(`%LOCALAPPDATA%`) before the shared resolver considers a migrated literal
user-home-relative directory. Provider IDs and Windows path literals must not
leak into extension or Agent lifecycle policy.

System proxy resolution follows the same shared precedence on macOS and
Windows: session/process environment, then the operating-system static proxy,
then direct connection. The common resolver owns merging, `NO_PROXY`, caching,
diagnostics, and the `TUTTI_DISABLE_PROXY_AUTODETECT` escape hatch. Build-tagged
adapters only read native state: Darwin uses `scutil --proxy`; Windows reads the
current-user WinINet `Internet Settings` values. Windows protocol maps and
bypass entries are normalized to `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`.
PAC execution and SOCKS conversion remain out of scope because the daemon does
not embed a PAC/SOCKS engine. WinINet bypass entries that cannot be represented
faithfully by standard `NO_PROXY` syntax (for example `10.*` and `<local>`) are
not projected; loopback, `.local`, exact hosts, and `*.domain` suffixes remain
covered.

Agent Target setup uses one Desktop-owned, version-pinned `uv` resource rather
than downloading `uv` separately for each Python agent. Release staging copies
the official compressed archive for each packaged architecture under
`bin/managed-uv/<platform>/<version>/`; both staging and tuttid verify the
pinned size and SHA-256. Electron injects only the resource root through
`TUTTI_BUNDLED_UV_ROOT`. The daemon keeps extraction, cache markers, and the
dynamic official-download fallback. Node, Python, Kimi, Hermes, and other agent
payloads remain dynamically installed, so this adds roughly one compressed uv
archive per architecture rather than a complete cross-language toolchain.

The signed macOS release is the one packaging exception. The upstream macOS
archives contain nested `uv` and `uvx` executables without Tutti's Developer ID
signature, so Apple notarization rejects the archive when it is embedded in the
app. macOS therefore uses the same pinned, checksum-verified dynamic download
fallback at first use; Windows and Linux continue to ship their bundled uv
archive.

For generic ACP providers such as OpenCode, provider resolution rewrites the
adapter command once and every status, login, model-catalog, and session path
uses that resolved executable. On Windows a complete isolated npm package is
preferred over an earlier stale PATH shim; package metadata and containment are
validated before its declared binary is accepted.

The Windows Desktop package also vendors the pinned Mutagen executable used
when file-symlink creation is unavailable. Electron resolves the packaged
resource and injects `TUTTI_MUTAGEN_BIN` into `tuttid`; Workspace Apps inherit
that same absolute path. Release staging downloads the official archive and
license texts, verifies their pinned SHA-256 digests, and packages only the
Windows amd64 executable and notices. Runtime execution therefore has no
Mutagen download dependency, while an explicit `TUTTI_MUTAGEN_BIN` remains an
operator override. If the packaged or configured executable is unavailable,
runtime preparation uses a guarded per-run auth copy and copies a valid
refreshed credential back only when the stable source has not changed
concurrently.

### Browser and Files

Browser and Files do not require broad platform interfaces by default. Keep API,
state, validation, and orchestration shared. Introduce or extend a narrow
adapter only after a real difference is identified, such as browser executable
discovery, profile location, process termination, path containment, atomic
move, or timestamp behavior. Prefer standard Go and Electron APIs when they
already provide equivalent semantics.

### Computer use

Computer use keeps the Tutti MCP/tool policy and session lifecycle shared. On
Windows, the narrow adapter invokes the installed Cua Driver 0.18.0 binary,
uses its read-only `doctor --json` probe for readiness, and lazily owns a local
`serve` process while the computer service is active. The desktop resolves the
official per-user install locations and passes an explicit entry path when it
starts a new `tuttid`; the daemon also resolves those locations so an install
performed while the current desktop process is running is visible without a
restart. The native UI Automation, capture, and input implementation remains
inside Cua Driver rather than becoming a Tutti platform library.

Daemon startup readiness is bounded but tolerant of transient status failures.
If the service still owns a live `serve` process, a later readiness check polls
again instead of failing immediately. A process exit before readiness and a
readiness timeout remain distinct, sanitized diagnostic errors.

The desktop does not currently vendor `cua-driver.exe` into the Windows
package. Users or deployment tooling must install the pinned driver (or set
`TUTTI_COMPUTER_MCP_ENTRY_PATH`); packaging a signed helper is a separate
promotion decision. Updating the driver version requires rerunning the doctor,
MCP contract, and real screenshot/input gates before changing the pin.

## Packaging And Release Boundary

The Alpha workflow is intentionally separate from the formal desktop release:

- `.github/workflows/windows-agent-adapters.yml` and
  `.github/workflows/windows-daemon-adapters.yml` provide focused pull-request
  coverage and maintain reusable caches on matching `main` pushes; they do not
  produce desktop packages;
- `.github/workflows/windows-desktop-alpha.yml` always tests Windows x64 and
  builds the Desktop bundles for pull requests;
- pull requests build, smoke-test, and upload an unsigned NSIS installer only
  when Desktop packaging inputs change; manual runs always produce the
  installer;
- the workflow does not publish a GitHub Release or mutate stable/prerelease
  update metadata;
- `.github/workflows/desktop-release.yml` signs every non-dry-run Windows
  package with Certum SimplySign, independently verifies the installer,
  embedded uninstaller, and internal EXEs on Windows, then stages Windows
  beside macOS assets.

Windows may enter a formal Beta/RC or stable channel only after all applicable
gates below pass:

- Windows 10 and Windows 11 x64 install, launch, upgrade, rollback, and uninstall
  verification on real or cloud machines;
- Onboarding, Browser, Files, Terminal, and AgentGUI end-to-end verification;
- successful Authenticode smoke and formal-package runs using the organization-
  owned Certum SimplySign configuration;
- managed Bash license, notice, and corresponding-source distribution review;
- crash/log collection and release-asset traceability;
- formal release staging, updater metadata, mirror, notification, and rollback
  tests.

Automated signing is one release boundary, not proof of the remaining
real-machine gates. Public channel enablement must continue to follow the
release policy and its protected stable-candidate approval rather than treating
a successful signing job as complete Windows support evidence.

The stable Microsoft Store path is a separate, opt-in release surface:

- `pnpm --filter @tutti-os/desktop build:win:store` reuses the Windows payload
  and emits one x64 AppX submission package;
- `.github/workflows/desktop-store-submit.yml` accepts only a plain stable tag,
  verifies that the tag and commit match, validates the package identity,
  publisher, four-part version, architecture, and SHA-256, then optionally
  submits it with the official Microsoft Store Developer CLI;
- `.github/workflows/desktop-release.yml` calls that workflow only when
  `TUTTI_WINDOWS_STORE_SUBMISSION_ENABLED=true`, the publication mode is
  `publish`, and Direct promotion has succeeded; the Store job is downstream
  from, never a dependency of, Direct staging or promotion;
- the AppX manifest registers the `tutti` login callback protocol and the Store
  workflow verifies that registration together with `runFullTrust`;
- RC and beta tags remain Direct-only. A separate Store beta product or package
  flight is not part of this implementation.

The first Store submission is a one-time Partner Center operation: upload the
validated AppX artifact and complete the listing, properties, age rating,
pricing, and availability there. The Store Developer CLI does not implement a
first submission from a loose MSIX file. Once that first submission has been
accepted, later stable package updates use the automated Store workflow.

Microsoft Store submission does not make the Direct NSIS installer signed. The
Store package may be treated as a supported public download only after its
Partner Center certification, installation, sidecar, protocol, update, and
uninstall gates have passed on real Windows systems.

## Iteration Path

1. **Alpha foundation:** keep Windows build and automated adapter/Onboarding
   checks green in the isolated workflow.
2. **Product-chain validation:** exercise Browser, Files, Terminal, Agent
   install/start, AgentGUI launch, persistence, event push, and restart recovery
   on Windows 10 and Windows 11 x64.
3. **Store prototype:** use the manual Store workflow with its submission flag
   disabled first, then validate a test Partner Center product before replacing
   the complete environment profile with production credentials and identity.
4. **Store stable release:** enable automatic stable submission only after
   certification and installation gates pass; keep Direct NSIS and Store update
   responsibility isolated.
5. **Additional architectures:** add an explicit platform key such as
   `windows-arm64`, its native artifacts, and CI coverage. Reuse common services
   and existing capability contracts unless ARM64 exposes a genuine new
   boundary.

Each phase must preserve the previous macOS path. A phase can be rolled back by
disabling its Windows workflow or publication integration without changing App
manifests or common lifecycle contracts.

## Non-Goals

- shipping a general-purpose Unix environment on Windows;
- requiring Git for Windows, WSL, or a user-installed Bash;
- adding `bootstrap.cmd` or a platform entrypoint matrix to every Workspace App;
- duplicating services, API contracts, or persistence models per platform;
- supporting Windows ARM64 before its binaries, packaging, and test matrix are
  explicitly added;
- publishing unsigned Alpha artifacts through stable or `latest` channels.
- publishing RC or beta builds to Microsoft Store in the first Store phase;
- mirroring a Store-signed package back to GitHub Releases or the Direct updater
  feed.

## Open Decisions

These items are not established by the current code and must not be presented
as completed support:

- the exact minimum supported Windows 10 release;
- whether Browser and Files are mandatory for the first externally distributed
  Alpha, rather than later preview promotion gates;
- Windows ARM64 schedule;
- the final public wording and timing for announcing Windows support.
- the production Partner Center product identity and least-privilege Entra
  application ownership;
- the version-controlled repository and staging environment for the
  `tutti-desktop-download` Worker;
- the exact Windows 10/11 Store install, update, sidecar, protocol, and data-path
  evidence required before enabling production submission.
