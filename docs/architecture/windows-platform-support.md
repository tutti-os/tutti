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

| Area                     | Shared owner                                            | Windows boundary                                           | Status                                                                                          |
| ------------------------ | ------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Desktop daemon lifecycle | Electron main process                                   | packages `tuttid.exe` and injects native resource paths    | Windows Alpha CI packages it                                                                    |
| Workspace Apps           | daemon app lifecycle, health, state, and events         | `AppShellAdapter` invokes the packaged managed POSIX shell | Onboarding fat package is exercised in Windows Alpha CI                                         |
| Terminal                 | terminal service and shared terminal contracts          | `TerminalProcessFactory` uses ConPTY                       | focused adapter and daemon WebSocket tests run in Windows daemon-adapter and Alpha CI           |
| Agent processes          | provider-neutral agent/runtime services                 | build-tagged executable, command, and process handling     | focused Windows tests run in Agent adapter and Alpha CI                                         |
| Browser                  | browser service contract                                | focused Windows executable/profile path behavior           | focused Windows tests exist; full browser E2E remains a promotion gate                          |
| Computer use             | computer service contract                               | Cua Driver 0.18.0 doctor/MCP boundary and owned daemon     | focused Windows tests and opt-in MCP smoke exist; screenshot/input E2E remains a promotion gate |
| Files                    | workspace file APIs and portable Go filesystem behavior | add a narrow adapter only where Windows semantics differ   | full Windows Files E2E remains a promotion gate                                                 |
| Release                  | desktop release policy                                  | unsigned NSIS plus a separately gated Store AppX artifact  | Store build/submission automation exists; production certification is not yet validated         |

Passing `windows-latest` CI proves the build and automated paths above. It does
not by itself prove the supported Windows 10 floor, installer UX, upgrade, or
uninstall behavior on real machines.

## Architecture Rules

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

This is dependency inversion at the native boundary, not a requirement to
create parallel copies of each service.

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
creation stay in the runtime command/process boundary. Do not make provider
installers assemble shell command strings to handle Windows.

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
- `.github/workflows/windows-desktop-alpha.yml` builds and tests Windows x64;
- the output is an unsigned NSIS installer uploaded as a workflow artifact;
- the workflow does not publish a GitHub Release or mutate stable/prerelease
  update metadata;
- `.github/workflows/desktop-release.yml` currently stages only macOS assets.

Windows may enter a formal Beta/RC or stable channel only after all applicable
gates below pass:

- Windows 10 and Windows 11 x64 install, launch, upgrade, rollback, and uninstall
  verification on real or cloud machines;
- Onboarding, Browser, Files, Terminal, and AgentGUI end-to-end verification;
- Authenticode signing for the installer and required executables, with signing
  identity and secret ownership decided;
- managed Bash license, notice, and corresponding-source distribution review;
- crash/log collection and release-asset traceability;
- formal release staging, updater metadata, mirror, notification, and rollback
  tests.

Until those gates pass, Windows artifacts must not be added to `latest.json`,
the floating stable release, public stable downloads, or formal release
notifications.

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
- the Authenticode provider and certificate/secret ownership;
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
