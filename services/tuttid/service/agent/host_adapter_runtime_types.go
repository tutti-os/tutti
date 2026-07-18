package agent

import (
	"context"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

// RuntimeOperationStore is the tuttid storage adapter shape. The coordinator
// itself lives exclusively in packages/agent/host.
type RuntimeOperationStore interface {
	agenthost.RuntimeOperationStore
	FindTurnByClientSubmitID(context.Context, string, string, string) (string, bool, error)
}

type RuntimeOperationEventPublisher = agenthost.RuntimeOperationEventPublisher

var ErrRuntimeOperationInProgress = agenthost.ErrRuntimeOperationInProgress
var ErrRuntimeOperationFailed = agenthost.ErrRuntimeOperationFailed
