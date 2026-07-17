package agentextension

import (
	"context"
	"errors"
	"fmt"
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
		methods = append(methods, RuntimeAuthMethod(method))
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
