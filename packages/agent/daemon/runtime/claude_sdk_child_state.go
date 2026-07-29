package agentruntime

import activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"

func claudeSDKMergeChildStatus(current string, incoming string) string {
	current = firstNonEmptyString(claudeSDKNormalizeTaskStatus(current), string(activityshared.ActivityStatusRunning))
	incoming = claudeSDKNormalizeTaskStatus(incoming)
	if claudeSDKChildStatusIsTerminal(current) {
		return current
	}
	return firstNonEmptyString(incoming, current)
}
