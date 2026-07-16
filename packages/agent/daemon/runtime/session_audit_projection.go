package agentruntime

import (
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func newSessionAuditEventWithID(session Session, eventID string, role string, content string, payload map[string]any) activityshared.Event {
	ctx, ok := activityEventContext(session, eventID, "")
	if !ok {
		return activityshared.Event{}
	}
	if strings.TrimSpace(role) == "" {
		role = RoleUser
	}
	metadata := clonePayload(payload)
	if metadata == nil {
		metadata = map[string]any{}
	}
	metadata["auditId"] = strings.TrimSpace(eventID)
	return activityshared.NewSessionAudit(ctx, activityshared.MessageRole(strings.TrimSpace(role)), content, metadata)
}
