# AGENTS.md

## Scope

This file applies to `packages/agent/daemon/*`. Read the root
`AGENTS.md`, `packages/AGENTS.md`, and
`docs/architecture/windows-platform-support.md` before changing this runtime.

## Cross-platform runtime contract

Agent runtimes launch external programs and exchange host filesystem paths with
provider protocols. Treat every change in this directory as platform-sensitive
unless it is provably platform-neutral.

- Construct host paths with Go's `filepath` APIs and injected workspace, state,
  home, or temporary roots. Do not use POSIX-rooted literals as host paths.
- For path-bearing provider fields such as `cwd`, writable roots, executable
  paths, sockets, and configuration locations, preserve the base required by
  the receiving schema and validate the fully materialized value before launch.
- Keep provider virtual paths separate from host paths. A virtual path may cross
  the boundary only when the provider contract explicitly defines its namespace
  and translation semantics on Windows.
- Resolve commands through the runtime command adapter. Do not assume a bare
  command, Unix executable bit, shebang, `.exe`, `.cmd`, `.ps1`, PATH layout, or
  shell quoting behaves identically across platforms.
- Prefer argv-based process launch. Do not add `sh -c`, `cmd /c`, or PowerShell
  string construction without an owning adapter and focused quoting tests.
- Cover platform-sensitive changes with POSIX and Windows cases. Tests must
  exercise the receiving schema, parser, command resolver, or process boundary;
  asserting only the emitted map or JSON string is not sufficient.

When a real Windows boundary cannot run in the local environment, add the
closest deterministic contract test, ensure the applicable Windows CI lane owns
the scenario, and state the remaining verification gap in the change summary.
