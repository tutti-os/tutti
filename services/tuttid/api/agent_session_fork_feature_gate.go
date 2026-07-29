package api

import (
	"context"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

// agentSessionForkWritesEnabled reports whether callers may create new Session
// forks. Reads and acknowledgements remain available so existing operations and
// lineage stay observable when the Lab experiment is disabled.
func (api DaemonAPI) agentSessionForkWritesEnabled(ctx context.Context) bool {
	if api.PreferencesService == nil {
		return false
	}
	preferences, err := api.PreferencesService.Get(ctx)
	if err != nil {
		return false
	}
	return preferencesbiz.IsLabFlagEnabled(
		preferences.FeatureFlags,
		preferencesbiz.LabFlagAgentSessionFork,
	)
}

func agentSessionForkWriteDisabledError() tuttigenerated.InvalidRequestErrorJSONResponse {
	return invalidRequestError(apierrors.InvalidRequest(
		"agent_session_fork_disabled",
		apierrors.WithDeveloperMessage(
			"agent session fork writes require the lab.agentSessionFork feature flag",
		),
	))
}
