package hostadapter

import (
	"context"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
)

type sessionForkRuntimeBackend interface {
	ForkCapabilities(context.Context, agentruntime.Session) (agentruntime.SessionForkCapabilities, error)
	CanForkProviderTurn(context.Context, agentruntime.ProviderTurnForkabilityInput) (bool, error)
	Fork(context.Context, agentruntime.SessionForkInput) (agentruntime.SessionForkResult, error)
}
