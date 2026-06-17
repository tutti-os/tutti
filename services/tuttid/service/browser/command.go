package browser

import (
	"context"
	"encoding/json"
	"os"
	"strings"

	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

// chrome-devtools-mcp launch resolution. The daemon now consumes this command
// directly (it runs the MCP server as its own subprocess) instead of
// advertising it to agent providers. Operator overrides via
// TUTTI_BROWSER_MCP_COMMAND / TUTTI_BROWSER_MCP_ARGS still apply. Packaged
// desktop points TUTTI_BROWSER_MCP_ENTRY_PATH at its vendored entry script; dev
// falls back to the pinned npx command below.
const (
	browserMCPCommandOverrideEnv = "TUTTI_BROWSER_MCP_COMMAND"
	browserMCPArgsOverrideEnv    = "TUTTI_BROWSER_MCP_ARGS"
	browserMCPEntryPathEnv       = "TUTTI_BROWSER_MCP_ENTRY_PATH"

	// browserMCPPinnedVersion pins the chrome-devtools-mcp release for the npx
	// fallback so dev runs are reproducible.
	browserMCPPinnedVersion = "chrome-devtools-mcp@1.2.0"
)

// defaultBrowserMCPCommand / Args launch chrome-devtools-mcp in external-Chrome
// mode (the server manages its own Chrome). Launch-mode args are appended after
// resolving desktop preferences.
var (
	defaultBrowserMCPCommand = "npx"
	defaultBrowserMCPArgs    = []string{"-y", browserMCPPinnedVersion}
)

// resolveBrowserMCPCommand returns the full command (command + args) used to
// launch the browser MCP server, honoring operator overrides.
func resolveBrowserMCPCommand(ctx context.Context, preferences PreferencesReader) []string {
	command, args := resolveBrowserMCPBaseCommand()
	if raw := strings.TrimSpace(os.Getenv(browserMCPArgsOverrideEnv)); raw != "" {
		var override []string
		if err := json.Unmarshal([]byte(raw), &override); err == nil {
			args = override
			return append([]string{command}, args...)
		}
	}
	mode := resolveBrowserUseConnectionMode(ctx, preferences)
	args = append(args, resolveBrowserMCPConnectionArgs(mode)...)
	return append([]string{command}, args...)
}

func resolveBrowserMCPBaseCommand() (string, []string) {
	if command := strings.TrimSpace(os.Getenv(browserMCPCommandOverrideEnv)); command != "" {
		return command, []string{}
	}
	if entry := strings.TrimSpace(os.Getenv(browserMCPEntryPathEnv)); entry != "" {
		return "node", []string{entry}
	}
	return defaultBrowserMCPCommand, append([]string(nil), defaultBrowserMCPArgs...)
}

func resolveBrowserMCPConnectionArgs(mode string) []string {
	switch mode {
	case "autoConnect":
		return resolveAutoConnectMCPConnectionArgs()
	default:
		return []string{"--isolated", "--no-usage-statistics"}
	}
}

func resolveBrowserUseConnectionMode(ctx context.Context, preferences PreferencesReader) string {
	if preferences == nil {
		return preferencesbiz.DefaultDesktopBrowserUseConnectionMode
	}
	stored, err := preferences.GetDesktopPreferences(ctx)
	if err != nil {
		return preferencesbiz.DefaultDesktopBrowserUseConnectionMode
	}
	mode := strings.TrimSpace(stored.BrowserUseConnectionMode)
	if preferencesbiz.IsDesktopBrowserUseConnectionMode(mode) {
		return mode
	}
	return preferencesbiz.DefaultDesktopBrowserUseConnectionMode
}
