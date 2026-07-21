package api

import (
	"context"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

// modelPlansWritesEnabled reports whether model plan and agent model binding
// write routes are enabled. The Lab registry defaults the flag off: writes are
// rejected unless the flag is explicitly true, while reads and existing
// bindings keep working.
func (api DaemonAPI) modelPlansWritesEnabled(ctx context.Context) bool {
	if api.PreferencesService == nil {
		return false
	}
	preferences, err := api.PreferencesService.Get(ctx)
	if err != nil {
		return false
	}
	return preferencesbiz.IsLabFlagEnabled(preferences.FeatureFlags, preferencesbiz.LabFlagModelPlans)
}

func modelPlansWriteDisabledError() tuttigenerated.InvalidRequestErrorJSONResponse {
	return invalidRequestError(apierrors.InvalidRequest(
		"model_plans_disabled",
		apierrors.WithDeveloperMessage("model plan writes require the lab.modelPlans feature flag"),
	))
}
