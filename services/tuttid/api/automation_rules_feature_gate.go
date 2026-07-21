package api

import (
	"context"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
)

// AutomationRulesFeatureFlag is the lab flag that gates automation rule and
// collaboration run write routes while the feature rolls out.
const AutomationRulesFeatureFlag = "lab.automationRules"

// automationRulesWritesEnabled reports whether automation rule and
// collaboration run write routes are enabled. The lab flag defaults off:
// writes are rejected unless the flag is explicitly true, while reads and
// already-established rules and runs keep working. Mirrors
// workspaceAgentsWritesEnabled.
func (api DaemonAPI) automationRulesWritesEnabled(ctx context.Context) bool {
	if api.PreferencesService == nil {
		return false
	}
	preferences, err := api.PreferencesService.Get(ctx)
	if err != nil {
		return false
	}
	return preferences.FeatureFlags[AutomationRulesFeatureFlag]
}

func automationRulesWriteDisabledError() tuttigenerated.InvalidRequestErrorJSONResponse {
	return invalidRequestError(apierrors.InvalidRequest(
		"automation_rules_disabled",
		apierrors.WithDeveloperMessage("automation rule and collaboration run writes require the lab.automationRules feature flag"),
	))
}
