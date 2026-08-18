package turn_terminal

import (
	"context"

	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
	reporterevents "github.com/tutti-os/tutti/services/tuttid/service/reporter/events"
)

const (
	EventCompleted = "agent.turn_completed"
	EventFailed    = "agent.turn_failed"
	EventCancelled = "agent.turn_cancelled"
)

type Params map[string]any

func Track(ctx context.Context, reporter reporterservice.Reporter, eventName string, params Params) {
	reporterevents.Track(ctx, reporter, eventName, map[string]any(params))
}
