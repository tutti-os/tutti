package agent

import (
	"context"

	modelgatewayservice "github.com/tutti-os/tutti/services/tuttid/service/modelgateway"
)

// ModelGatewayRegistry is the daemon-owned, session-scoped Responses-to-Chat
// route registry used by model-plan launches whose runtime requires the Responses API.
type ModelGatewayRegistry interface {
	Register(context.Context, modelgatewayservice.Route) (modelgatewayservice.ClientEndpoint, error)
	Unregister(context.Context, string, string)
}
