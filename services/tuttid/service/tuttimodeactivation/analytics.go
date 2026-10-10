package tuttimodeactivation

import (
	"context"

	activationbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeactivation"
	reporterevents "github.com/tutti-os/tutti/services/tuttid/service/reporter/events"
)

const tuttiModeActivationChangedEvent = "tutti_mode.activation_changed"

func (s *Service) reportActivationChanged(ctx context.Context, activation activationbiz.Activation) {
	if s == nil || s.AnalyticsReporter == nil {
		return
	}
	revision := activation.CurrentRevision
	action := ""
	switch revision.State {
	case activationbiz.StateActive:
		action = "activated"
	case activationbiz.StateInactive:
		action = "deactivated"
	default:
		return
	}
	if !activationbiz.IsUserStateSource(revision.State, revision.Source) {
		return
	}
	reporterevents.Track(ctx, s.AnalyticsReporter, tuttiModeActivationChangedEvent, map[string]any{
		"action": action,
		"source": string(revision.Source),
		"state":  string(revision.State),
	})
}
