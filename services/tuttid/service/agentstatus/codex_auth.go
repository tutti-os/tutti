package agentstatus

import (
	"context"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
)

type CodexAuthProbeEvidence struct {
	State        agentruntime.CodexAppServerAccountState
	AccountLabel string
	AuthMethod   string
}

func (s Service) probeCodexAuth(
	ctx context.Context,
	command []string,
	env []string,
	timeout time.Duration,
) CodexAuthProbeEvidence {
	if s.CodexAuthProbe != nil {
		return s.CodexAuthProbe(ctx, append([]string(nil), command...), append([]string(nil), env...))
	}
	result := agentruntime.ProbeCodexAppServer(ctx, agentruntime.CodexAppServerProbeInput{
		Command: command,
		Env:     env,
		Host: agentruntime.HostMetadata{ClientInfo: agentruntime.ClientInfo{
			Name: "tutti-desktop", Title: "Tutti", Version: "0.1.0",
		}},
		ReadAccount:      true,
		StartupTimeout:   timeout,
		HandshakeTimeout: timeout,
		ShutdownTimeout:  s.probeReadyAfter(),
	})
	return CodexAuthProbeEvidence{
		State:        result.AccountState,
		AccountLabel: result.AccountLabel,
		AuthMethod:   result.AuthMethod,
	}
}

func authInfoFromCodexProbe(evidence CodexAuthProbeEvidence) AuthInfo {
	switch evidence.State {
	case agentruntime.CodexAppServerAccountAuthenticated:
		return AuthInfo{
			Status:       AuthAuthenticated,
			AccountLabel: evidence.AccountLabel,
			AuthMethod:   evidence.AuthMethod,
		}
	case agentruntime.CodexAppServerAccountRequired:
		return AuthInfo{Status: AuthRequired}
	default:
		return AuthInfo{Status: AuthUnknown}
	}
}
