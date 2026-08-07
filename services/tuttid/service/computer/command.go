package computer

import (
	"context"
	"os"
	"strings"
)

// cua-driver launch resolution. TUTTI_COMPUTER_MCP_ENTRY_PATH points at an
// explicit binary for packaged/operator installs; Windows also discovers the
// official per-user install locations so an in-process install is visible
// without restarting tuttid.
const (
	computerMCPCommandOverrideEnv = "TUTTI_COMPUTER_MCP_COMMAND"
	computerMCPEntryPathEnv       = "TUTTI_COMPUTER_MCP_ENTRY_PATH"
)

var (
	defaultComputerMCPCommand = "cua-driver"
	defaultComputerMCPArgs    = []string{"mcp"}
)

// resolveComputerMCPCommand returns the full command used to launch the
// cua-driver MCP server, honoring operator overrides.
func resolveComputerMCPCommand(_ context.Context) []string {
	// The override is treated as the binary path; "mcp" is always appended as the subcommand.
	if command := strings.TrimSpace(os.Getenv(computerMCPCommandOverrideEnv)); command != "" {
		return []string{command, "mcp"}
	}
	if entry := strings.TrimSpace(os.Getenv(computerMCPEntryPathEnv)); entry != "" {
		return []string{entry, "mcp"}
	}
	if entry := resolveInstalledComputerDriver(); entry != "" {
		return []string{entry, "mcp"}
	}
	return append([]string{defaultComputerMCPCommand}, defaultComputerMCPArgs...)
}

// computerMCPSubprocessEnv returns extra env for the cua-driver subprocess.
// cua-driver does not need proxy exclusions, so this returns nil.
func computerMCPSubprocessEnv() []string {
	return nil
}
