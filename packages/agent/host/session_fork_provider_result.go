package agenthost

import (
	"encoding/json"
	"strings"
)

func validSessionForkProviderResult(
	result RuntimeSessionForkResult,
) bool {
	switch result.StateBindingMode {
	case SessionForkStateBindingHostCopy:
		return len(result.TargetProviderTurnBindings) == 0 &&
			result.StateBindingReceipt == ""
	case SessionForkStateBindingProviderOwned:
		if result.StateBindingReceipt == "" ||
			len(result.TargetProviderTurnBindings) == 0 {
			return false
		}
		seenProviderTurnIDs := make(
			map[string]struct{},
			len(result.TargetProviderTurnBindings),
		)
		for _, binding := range result.TargetProviderTurnBindings {
			providerTurnID := strings.TrimSpace(binding.ProviderTurnID)
			var providerBinding map[string]any
			if providerTurnID == "" ||
				json.Unmarshal(binding.ProviderTurnBindingJSON, &providerBinding) != nil ||
				len(providerBinding) == 0 {
				return false
			}
			if _, duplicate := seenProviderTurnIDs[providerTurnID]; duplicate {
				return false
			}
			seenProviderTurnIDs[providerTurnID] = struct{}{}
		}
		return true
	default:
		return false
	}
}
