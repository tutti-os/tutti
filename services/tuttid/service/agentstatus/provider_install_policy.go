package agentstatus

import "strings"

func isCodexAppServerCommand(command []string) bool {
	return len(command) >= 2 && strings.EqualFold(strings.TrimSpace(command[1]), "app-server")
}

func legacyRuntimeFailureRequiresRepair(spec ProviderSpec, reasonCode string) bool {
	switch strings.TrimSpace(reasonCode) {
	case "acp_adapter_launch_failed":
		return !isCodexStatusSpec(spec)
	default:
		return false
	}
}
