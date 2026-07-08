package agentruntime

// Cursor CLI's ACP provider config. Cursor speaks ACP natively via the
// `cursor-agent acp` subcommand (newer installers ship the binary as `agent`).
//
// Model selection is live: session/new advertises a `model` config option
// (parameterized ids such as "claude-sonnet-5[thinking=true,...]", with
// "default[]" for Auto) whose option entries carry {value, name}, so the
// shared engine's config-option flow both surfaces the list to the GUI and
// applies changes via session/set_config_option. The `--model` CLI root flag
// does NOT control the ACP session (the account-persisted choice wins) and
// side-effectfully rewrites ~/.cursor/cli-config.json — never pass it here.
//
// Permissions are exposed as approval tiers (matching the Codex/Claude Code
// experience) rather than Cursor's raw agent/plan/ask execution modes:
//
//	read-only   -> ACP session mode "plan" (reads and proposes, no changes)
//	agent       -> ACP session mode "agent"; Cursor sends
//	               session/request_permission per risky action (default)
//	full-access -> ACP session mode "agent"; the client auto-approves every
//	               session/request_permission
//
// full-access uses live client-side auto-approval rather than the `--force`
// spawn flag so all three tiers switch live (no respawn, no "requires a new
// session" error). Cursor still refuses commands its own deny list blocks
// before it ever asks, so auto-approving the requests it does send matches
// `--force` ("allow unless explicitly denied"). Live-probed against
// cursor-agent 2026.07.01: agent mode prompts for every risky action
// (including shell), while `--auto-review` is inert over ACP — so there is no
// honest "approve for me" middle tier.

import (
	"context"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
)

// cursorAgentBinaryNames lists the Cursor CLI binary names in resolution
// order: the long-standing `cursor-agent` name first, then the bare `agent`
// name newer official installers ship.
var cursorAgentBinaryNames = []string{"cursor-agent", "agent"}

// Cursor permission tier ids. "agent" doubles as the pre-tier default mode id
// persisted by earlier sessions, which keeps their behavior unchanged.
const (
	cursorPermissionReadOnly   = "read-only"
	cursorPermissionAgent      = "agent"
	cursorPermissionFullAccess = "full-access"
)

const cursorPluginDirEnv = "TUTTI_CURSOR_PLUGIN_DIR"

// cursorACPModeID maps Tutti permission tiers onto Cursor's ACP session
// modes (switched via session/set_mode). Approval strictness within "agent"
// is governed by the spawn command, not the session mode.
func cursorACPModeID(mode string) string {
	switch strings.TrimSpace(mode) {
	case cursorPermissionReadOnly:
		return "plan"
	case cursorPermissionAgent, cursorPermissionFullAccess:
		return "agent"
	default:
		return ""
	}
}

// cursorAutoApprovePermissionDecision auto-approves permission requests in the
// full-access tier and prompts (returns "") in every other tier.
func cursorAutoApprovePermissionDecision(permissionModeID string) string {
	if strings.TrimSpace(permissionModeID) == cursorPermissionFullAccess {
		return "approved"
	}
	return ""
}

// cursorACPCommandResolver picks the installed Cursor CLI binary at spawn
// time so the adapter works with either binary name without a registry
// round-trip. An empty resolution keeps the config's default command.
func cursorACPCommandResolver(context.Context, string) (ProviderCommand, error) {
	resolver := runtimecmd.Resolver{}
	if path := resolver.ResolveBinary(cursorAgentBinaryNames, nil); path != "" {
		return ProviderCommand{Command: []string{path, "acp"}}, nil
	}
	return ProviderCommand{}, nil
}

func cursorACPCommandWithPluginDir(command []string, session Session) []string {
	out := append([]string(nil), command...)
	pluginDir := sessionEnvValue(session.Env, cursorPluginDirEnv)
	if pluginDir == "" || len(out) == 0 || hasCursorPluginDirArg(out) {
		return out
	}
	return append([]string{out[0], "--plugin-dir", pluginDir}, out[1:]...)
}

func hasCursorPluginDirArg(command []string) bool {
	for _, arg := range command {
		if arg == "--plugin-dir" || strings.HasPrefix(arg, "--plugin-dir=") {
			return true
		}
	}
	return false
}

func NewCursorAdapter(transport ProcessTransport) *standardACPAdapter {
	return NewCursorAdapterWithHostMetadata(transport, LegacyHostMetadata())
}

func NewCursorAdapterWithHostMetadata(transport ProcessTransport, host HostMetadata) *standardACPAdapter {
	return newCursorAdapterWithHostMetadata(transport, host, cursorACPCommandResolver)
}

func newCursorAdapterWithHostMetadata(
	transport ProcessTransport,
	host HostMetadata,
	commandResolver ProviderCommandResolver,
) *standardACPAdapter {
	return &standardACPAdapter{
		config: standardACPConfig{
			provider:            ProviderCursor,
			adapterName:         "cursor-acp",
			command:             []string{"cursor-agent", "acp"},
			defaultTitle:        "Cursor Agent",
			defaultTitleAliases: []string{"Cursor", ProviderCursor, "cursor-agent"},
			authRequiredMessage: "Cursor ACP requires authentication; run `cursor-agent login` (or set CURSOR_API_KEY) on the host, then retry this session.",
			permissionModeID:    cursorACPModeID,
			initializeParams:    func() map[string]any { return defaultACPInitializeParams(host) },
			env:                 func(session Session) []string { return standardACPEnv(session, host) },
			commandResolver:     commandResolver,
			commandWithSettings: cursorACPCommandWithPluginDir,
			// full-access auto-approves permission requests live; all tiers
			// switch without a respawn.
			autoApprovePermissionDecision: cursorAutoApprovePermissionDecision,
			// cursor-agent ends the turn "successfully" after streaming
			// transient upstream failures (RetriableError/ConnectError) as
			// plain text; auto-continue instead of stalling the conversation.
			autoContinueRetriableTurnError: true,
		},
		transport: transport,
		host:      host,
		sessions:  make(map[string]*standardACPSession),
	}
}
