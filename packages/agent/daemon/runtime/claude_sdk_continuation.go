package agentruntime

import activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"

func claudeSDKSidecarBackgroundTaskEvents(
	adapterSession *claudeSDKAdapterSession,
	session Session,
	event claudeSDKSidecarEvent,
) ([]activityshared.Event, bool) {
	switch event.Type {
	case "background_tasks_changed", "continuation_delayed":
		return nil, true
	case "background_tasks_quiesced":
		if payloadInt64(event.Payload, "runningCount") != 0 {
			return nil, true
		}
		return adapterSession.endUnresolvedClaudeSDKBackgroundChildren(session), true
	default:
		return nil, false
	}
}
