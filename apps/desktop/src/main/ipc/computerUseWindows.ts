export const CUA_DRIVER_WINDOWS_VERSION = "0.18.0";

export type WindowsCuaDriverAction = "install" | "uninstall";

export interface WindowsCuaDriverCommand {
  command: "powershell.exe";
  args: string[];
}

/**
 * Build a non-interactive Windows driver command.
 *
 * The upstream installer defaults AutoStart to true and registers a scheduled
 * task through UAC. That is safe in an interactive terminal, but an Electron
 * child process with ignored stdin can wait forever behind an invisible UAC
 * prompt. Invoke the downloaded script as a scriptblock instead, so install
 * can pass -NoAutoStart and uninstall can force-remove without Read-Host.
 */
export function buildWindowsCuaDriverCommand(
  action: WindowsCuaDriverAction,
  url: string,
  driverVersion = CUA_DRIVER_WINDOWS_VERSION
): WindowsCuaDriverCommand {
  const quotedUrl = powershellSingleQuoted(url);
  const quotedVersion = powershellSingleQuoted(driverVersion);
  const script = [
    "$ErrorActionPreference = 'Stop';",
    `$env:CUA_DRIVER_RS_VERSION = ${quotedVersion};`,
    ...(action === "uninstall"
      ? ["$env:CUA_DRIVER_RS_UNINSTALL_FORCE = '1';"]
      : []),
    `$installer = Invoke-RestMethod -Uri ${quotedUrl};`,
    action === "install"
      ? "& ([scriptblock]::Create([string]$installer)) -NoAutoStart;"
      : "& ([scriptblock]::Create([string]$installer));"
  ].join(" ");

  return {
    command: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script
    ]
  };
}

function powershellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
