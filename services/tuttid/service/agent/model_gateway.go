package agent

import (
	"context"

	modelgatewayservice "github.com/tutti-os/tutti/services/tuttid/service/modelgateway"
)

// ModelGatewayRegistry is the daemon-owned, session-scoped Responses-to-Chat
// route registry used only by Codex model-plan launches.
type ModelGatewayRegistry interface {
	Register(context.Context, modelgatewayservice.Route) (modelgatewayservice.ClientEndpoint, error)
	Unregister(context.Context, string, string)
}
