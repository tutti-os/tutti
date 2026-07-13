package agentruntime

import (
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func activityMessagesWithRole(events []activityshared.Event, role activityshared.MessageRole) []activityshared.Event {
	var out []activityshared.Event
	for _, event := range events {
		if (event.Type == activityshared.EventMessageAppended || event.Type == activityshared.EventMessageCreated) && (role == "" || event.Payload.Role == role) {
			out = append(out, event)
		}
	}
	return out
}

func activityEventsWithType(events []activityshared.Event, eventType activityshared.EventType) []activityshared.Event {
	var out []activityshared.Event
	for _, event := range events {
		if event.Type == eventType {
			out = append(out, event)
		}
	}
	return out
}

func hasStreamCallEvent(events []StreamEvent, callType string, status string) bool {
	for _, event := range events {
		if event.EventType != StreamEventMessageUpdate {
			continue
		}
		update, ok := event.Data.(agentsessionstore.WorkspaceAgentMessageUpdate)
		if !ok {
			continue
		}
		if update.Kind != "tool_call" {
			continue
		}
		if callType != "" && asString(update.Payload["callType"]) != callType {
			continue
		}
		if status != "" && update.Status != status && asString(update.Payload["status"]) != status {
			continue
		}
		return true
	}
	return false
}

func reportsWithTimelineItem(reports []agentsessionstore.ReportActivityInput, itemType string) []agentsessionstore.ReportActivityInput {
	var out []agentsessionstore.ReportActivityInput
	for _, report := range reports {
		for _, update := range report.MessageUpdates {
			if messageUpdateMatchesLegacyItemType(update, itemType) {
				out = append(out, report)
				break
			}
		}
	}
	return out
}

func waitForCondition(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition was not met")
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
