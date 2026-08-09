package eventstream

import (
	"fmt"
	"strings"
)

func validateDesktopAgentSessionLaunchModesByWorkspace(
	launchModes desktopAgentSessionLaunchModesByWorkspacePayload,
) error {
	for workspaceID, modesBySectionKey := range launchModes {
		if strings.TrimSpace(workspaceID) == "" {
			return fmt.Errorf("preferences.agentSessionLaunchModesByWorkspace has an empty workspace id")
		}
		if modesBySectionKey == nil {
			return fmt.Errorf("preferences.agentSessionLaunchModesByWorkspace.%s must be an object", workspaceID)
		}
		for sectionKey, mode := range modesBySectionKey {
			if strings.TrimSpace(sectionKey) == "" {
				return fmt.Errorf("preferences.agentSessionLaunchModesByWorkspace.%s has an empty project section key", workspaceID)
			}
			if mode != "local" && mode != "worktree" {
				return fmt.Errorf("preferences.agentSessionLaunchModesByWorkspace.%s.%s is unsupported", workspaceID, sectionKey)
			}
		}
	}
	return nil
}
