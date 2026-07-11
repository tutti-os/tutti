package agentruntime

import (
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/internal/titletext"
)

// The functions in this file project provider-local state changes into the
// normalized activity contract. They deliberately contain no transport or
// provider selection logic.
func normalizedSessionTitleEvent(session Session, update map[string]any) (activityshared.Event, bool) {
	title := titletext.Normalize(firstNonEmpty(
		asString(update["title"]),
		asString(update["name"]),
		asString(update["summary"]),
	))
	if title == "" || title == strings.TrimSpace(session.Title) {
		return activityshared.Event{}, false
	}
	return newSessionTitleActivityEvent(session, title), true
}

func normalizedConfigOptionsUpdatedEvent(session Session, update map[string]any) (activityshared.Event, bool) {
	ctx, ok := activityEventContext(session, newID(), "")
	if !ok {
		return activityshared.Event{}, false
	}
	event := activityshared.NewSessionUpdated(ctx, "")
	metadata := map[string]any{"sessionUpdateKind": "config_option_update"}
	if key := asString(update["key"]); key != "" {
		metadata["configOptionKey"] = key
	}
	event.Payload.Metadata = metadata
	return event, true
}

func normalizedUsageUpdatedEvent(session Session) (activityshared.Event, bool) {
	ctx, ok := activityEventContext(session, newID(), "")
	if !ok {
		return activityshared.Event{}, false
	}
	event := activityshared.NewSessionUpdated(ctx, "")
	event.Payload.Metadata = map[string]any{"sessionUpdateKind": "usage_update"}
	return event, true
}

func normalizedGoalUpdatedEvent(session Session, updateType string) (activityshared.Event, bool) {
	ctx, ok := activityEventContext(session, newID(), "")
	if !ok {
		return activityshared.Event{}, false
	}
	event := activityshared.NewSessionUpdated(ctx, "")
	event.Payload.Metadata = map[string]any{"sessionUpdateKind": strings.TrimSpace(updateType)}
	return event, true
}

// normalizedSessionUpdateKind reads the current contract first and accepts the
// former ACP-named key only for imported/durable event compatibility.
func normalizedSessionUpdateKind(metadata map[string]any) string {
	return firstNonEmpty(
		strings.TrimSpace(asString(metadata["sessionUpdateKind"])),
		strings.TrimSpace(asString(metadata["acpSessionUpdate"])),
	)
}
