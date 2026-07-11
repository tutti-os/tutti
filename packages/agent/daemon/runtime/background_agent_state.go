package agentruntime

import (
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// backgroundAgentStatusIsTerminal interprets the normalized background-agent
// projection consumed by the controller, independent of the provider that
// produced it.
func backgroundAgentStatusIsTerminal(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case string(activityshared.ActivityStatusCompleted), string(activityshared.ActivityStatusFailed), "cancelled", "canceled", "stopped":
		return true
	default:
		return false
	}
}
