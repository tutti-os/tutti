package accountrealtime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
	mobileremoteservice "github.com/tutti-os/tutti/services/tuttid/service/mobileremote"
	userpresenceservice "github.com/tutti-os/tutti/services/tuttid/service/userpresence"
)

const (
	deviceLinkAttemptChangedEvent      = "device_link.attempt.changed"
	connectorAuthorizationChangedEvent = "connector.authorization.changed"
	userDevicePresenceChangedEvent     = "user.device-presence.changed"
)

type MobileAttemptEventSource struct {
	Realtime *Service
}

func (source MobileAttemptEventSource) Run(ctx context.Context, _ string, _ string, notify func(string)) error {
	if source.Realtime == nil || notify == nil {
		return errors.New("mobile attempt realtime listener is unavailable")
	}
	return source.Realtime.Listen(ctx, "", deviceLinkAttemptChangedEvent, func(event Event) {
		var payload struct {
			AttemptID string `json:"attemptId"`
		}
		if json.Unmarshal(event.Payload, &payload) == nil {
			if attemptID := strings.TrimSpace(payload.AttemptID); attemptID != "" {
				notify(attemptID)
			}
		}
	})
}

type ConnectorAuthorizationEventSource struct {
	Realtime *Service
}

func (source ConnectorAuthorizationEventSource) RunAuthorizationEvents(ctx context.Context, accountID string, notify func()) error {
	if source.Realtime == nil || notify == nil {
		return errors.New("connector authorization realtime listener is unavailable")
	}
	return source.Realtime.Listen(ctx, accountID, connectorAuthorizationChangedEvent, func(event Event) {
		var payload struct {
			Revision uint64 `json:"revision"`
		}
		if json.Unmarshal(event.Payload, &payload) == nil && payload.Revision > 0 {
			notify()
		}
	})
}

func (s *Service) RunUserPresenceEvents(ctx context.Context, presence *userpresenceservice.Service) error {
	if s == nil || presence == nil {
		return errors.New("user presence realtime listener is unavailable")
	}
	return s.Listen(ctx, "", userDevicePresenceChangedEvent, func(event Event) {
		var payload struct {
			UserID              string                     `json:"userId"`
			Status              userpresenceservice.Status `json:"status"`
			ChangedAt           string                     `json:"changedAt"`
			AuthorityGeneration string                     `json:"authorityGeneration"`
			PresenceRevision    string                     `json:"presenceRevision"`
		}
		if json.Unmarshal(event.Payload, &payload) != nil {
			return
		}
		presence.HandleEvent(userpresenceservice.PresenceEvent{
			UserID: strings.TrimSpace(payload.UserID), SubscriptionID: strings.TrimSpace(event.Delivery.SubscriptionID),
			Status: payload.Status, AuthorityGeneration: strings.TrimSpace(payload.AuthorityGeneration),
			PresenceRevision: strings.TrimSpace(payload.PresenceRevision), ObservedAt: parseEventTime(payload.ChangedAt),
		})
	})
}

func parseEventTime(raw string) (result time.Time) {
	result, _ = time.Parse(time.RFC3339Nano, strings.TrimSpace(raw))
	return result
}

var (
	_ mobileremoteservice.AttemptEventSource = MobileAttemptEventSource{}
	_ market.AuthorizationEventSource        = ConnectorAuthorizationEventSource{}
)
