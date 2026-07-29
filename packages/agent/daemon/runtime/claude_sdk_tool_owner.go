package agentruntime

import (
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type claudeSDKToolEventOwner struct {
	turnID string
	child  claudeSDKChildSession
}

func (o claudeSDKToolEventOwner) event(
	session Session,
	payload map[string]any,
	eventType string,
	status string,
) activityshared.Event {
	if o.child.TurnID == "" {
		return claudeSDKToolActivityEvent(session, o.turnID, payload, eventType, status)
	}
	event := claudeSDKToolActivityEvent(
		claudeSDKChildRuntimeSession(session, o.child),
		o.child.TurnID,
		payload,
		eventType,
		status,
	)
	return claudeSDKEventForChild(event, o.child)
}

func (s *claudeSDKAdapterSession) claudeSDKToolEventOwner(rootTurnID string, payload map[string]any) claudeSDKToolEventOwner {
	root := claudeSDKToolEventOwner{turnID: strings.TrimSpace(rootTurnID)}
	if s == nil {
		return root
	}
	if payloadString(payload, "callType") == "subagent" {
		if parent, ok := s.claudeSDKDelegationParentForPayload(payload); ok {
			return claudeSDKToolEventOwner{turnID: parent.TurnID, child: parent}
		}
		return root
	}
	if child, ok := s.claudeSDKChildForPayload(payload); ok {
		return claudeSDKToolEventOwner{turnID: child.TurnID, child: child}
	}
	return root
}

// claudeSDKToolEventTargetsClosedTurn fences the event's actual owner. A
// delegation call is owned by the Session that launched it, while tools run by
// a child are owned by that child. Resolving aliases before applying this rule
// confuses a completed child with its still-open parent Agent call.
func (a *ClaudeCodeSDKAdapter) claudeSDKToolEventTargetsClosedTurn(
	adapterSession *claudeSDKAdapterSession,
	rootTurnID string,
	payload map[string]any,
) bool {
	owner := adapterSession.claudeSDKToolEventOwner(rootTurnID, payload)
	return a.turnAlreadySettled(adapterSession, owner.turnID)
}
