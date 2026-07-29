package agentextension

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	agentextensionbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentextension"
)

type RuntimeProbeStatus string

const (
	RuntimeProbeReady        RuntimeProbeStatus = "ready"
	RuntimeProbeAuthRequired RuntimeProbeStatus = "auth_required"
)

type RuntimeAuthMethod struct {
	ID          string
	Name        string
	Description string
	// Type is the provider-declared method kind (for example "terminal").
	Type string
	// TerminalCommand is the ready-to-run shell command for terminal-type
	// methods (runtime executable plus the provider-declared arguments).
	// Empty for methods driven through ACP authenticate.
	TerminalCommand string
}

type RuntimeProbeResult struct {
	Status      RuntimeProbeStatus
	AuthMethods []RuntimeAuthMethod
	Account     *RuntimeAuthenticatedAccount
}

type RuntimeAuthenticatedAccount = agentextensionbiz.AuthenticatedAccount

func ProbeRuntime(
	ctx context.Context,
	binding RuntimeBinding,
	agentTargetID string,
	cwd string,
	transport agentruntime.ProcessTransport,
	host agentruntime.HostMetadata,
) (RuntimeProbeResult, error) {
	return runRuntimeSetup(ctx, binding, agentTargetID, cwd, "", 20*time.Second, transport, host)
}

func AuthenticateRuntime(
	ctx context.Context,
	binding RuntimeBinding,
	agentTargetID string,
	cwd string,
	methodID string,
	transport agentruntime.ProcessTransport,
	host agentruntime.HostMetadata,
) (RuntimeProbeResult, error) {
	return runRuntimeSetup(ctx, binding, agentTargetID, cwd, methodID, 15*time.Minute, transport, host)
}

func runRuntimeSetup(
	ctx context.Context,
	binding RuntimeBinding,
	agentTargetID string,
	cwd string,
	methodID string,
	timeout time.Duration,
	transport agentruntime.ProcessTransport,
	host agentruntime.HostMetadata,
) (RuntimeProbeResult, error) {
	if transport == nil {
		return RuntimeProbeResult{}, errors.New("agent extension runtime probe transport is not configured")
	}
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	session := agentruntime.Session{
		RoomID: "agent-target-setup", AgentSessionID: "setup-probe-" + fmt.Sprint(time.Now().UnixNano()),
		AgentTargetID: agentTargetID, Provider: binding.Installation.Provider, CWD: cwd,
	}
	result, err := agentruntime.RunStandardACPSetup(
		probeCtx, runtimeAdapterConfig(binding, agentTargetID), transport, host, session, methodID,
	)
	if err != nil {
		return RuntimeProbeResult{}, err
	}
	methods := make([]RuntimeAuthMethod, 0, len(result.AuthMethods))
	for _, method := range result.AuthMethods {
		methods = append(methods, RuntimeAuthMethod{
			ID: method.ID, Name: method.Name, Description: method.Description,
			Type:            method.Type,
			TerminalCommand: terminalLoginCommand(binding.Command, method),
		})
	}
	var account *RuntimeAuthenticatedAccount
	if result.Account != nil {
		account = &RuntimeAuthenticatedAccount{
			ID: result.Account.ID, DisplayName: result.Account.DisplayName,
			AuthMethodID: result.Account.AuthMethodID, Organization: result.Account.Organization,
		}
	}
	return RuntimeProbeResult{Status: RuntimeProbeStatus(result.Status), AuthMethods: methods, Account: account}, nil
}

// terminalLoginCommand renders the interactive sign-in command for
// terminal-type auth methods. Provider-declared args come in two shapes: a
// subcommand for the runtime binary (["login"] renders `<agent> login`), or
// flags for the full ACP launch command (["--login"] renders
// `<agent> acp --login` — the form the native Kimi Code CLI declares as its
// ACP terminal-auth entry point).
func terminalLoginCommand(command []string, method agentruntime.StandardACPAuthMethod) string {
	if method.Type != "terminal" || len(command) == 0 || strings.TrimSpace(command[0]) == "" {
		return ""
	}
	base := command[:1]
	if len(method.Args) > 0 && strings.HasPrefix(method.Args[0], "-") {
		base = command
	}
	parts := make([]string, 0, len(base)+len(method.Args))
	for _, element := range base {
		parts = append(parts, shellQuote(element))
	}
	for _, arg := range method.Args {
		parts = append(parts, shellQuote(arg))
	}
	return strings.Join(parts, " ")
}

func shellQuote(value string) string {
	if value != "" && strings.IndexFunc(value, func(r rune) bool {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			return false
		}
		switch r {
		case '_', '.', '/', '-', ':', '=', '@', '+', ',':
			return false
		}
		return true
	}) == -1 {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}
