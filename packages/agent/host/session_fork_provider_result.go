package agenthost

import "strings"

func validSessionForkProviderResult(
	result RuntimeSessionForkResult,
	sourceProviderTurnIDs []string,
) bool {
	switch result.StateBindingMode {
	case SessionForkStateBindingHostCopy:
		return len(result.TargetProviderTurnIDs) == 0 &&
			result.StateBindingReceipt == ""
	case SessionForkStateBindingProviderOwned:
		if result.StateBindingReceipt == "" ||
			len(result.TargetProviderTurnIDs) != len(sourceProviderTurnIDs) {
			return false
		}
		seen := make(map[string]struct{}, len(result.TargetProviderTurnIDs))
		for _, rawID := range result.TargetProviderTurnIDs {
			id := strings.TrimSpace(rawID)
			if id == "" {
				return false
			}
			if _, duplicate := seen[id]; duplicate {
				return false
			}
			seen[id] = struct{}{}
		}
		return true
	default:
		return false
	}
}
