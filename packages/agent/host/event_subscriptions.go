package agenthost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

const (
	EventTypeAgentTurnCompleted   = canonical.EventTypeAgentTurnCompleted
	EventTypeAgentTurnFailed      = canonical.EventTypeAgentTurnFailed
	EventTypeAgentTurnCanceled    = canonical.EventTypeAgentTurnCanceled
	EventTypeAgentTurnInterrupted = canonical.EventTypeAgentTurnInterrupted

	eventDeliveryBatchSize      = 16
	eventDeliveryLeaseDuration  = 30 * time.Second
	eventDeliveryWorkerInterval = 500 * time.Millisecond
)

type EventTypeDefinition struct {
	Type       string `json:"type"`
	Version    int    `json:"version"`
	SourceKind string `json:"sourceKind"`
	OneShot    bool   `json:"oneShot"`
}

func EventTypeCatalog() []EventTypeDefinition {
	definitions := canonical.TerminalTurnEventDefinitions()
	result := make([]EventTypeDefinition, 0, len(definitions))
	for _, definition := range definitions {
		result = append(result, EventTypeDefinition{
			Type: definition.Type, Version: definition.Version,
			SourceKind: definition.SourceKind, OneShot: definition.OneShot,
		})
	}
	return result
}

func IsSupportedEventType(eventType string) bool {
	eventType = strings.TrimSpace(eventType)
	for _, definition := range EventTypeCatalog() {
		if definition.Type == eventType {
			return true
		}
	}
	return false
}

type CreateEventSubscriptionInput struct {
	SubscriptionID           string
	WorkspaceID              string
	SubscriberAgentSessionID string
	EventType                string
	SourceAgentSessionID     string
	SourceTurnID             string
}

func (h *Host) CreateEventSubscription(ctx context.Context, input CreateEventSubscriptionInput) (storesqlite.EventSubscription, error) {
	input.SubscriptionID = strings.TrimSpace(input.SubscriptionID)
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.SubscriberAgentSessionID = strings.TrimSpace(input.SubscriberAgentSessionID)
	input.EventType = strings.TrimSpace(input.EventType)
	input.SourceAgentSessionID = strings.TrimSpace(input.SourceAgentSessionID)
	input.SourceTurnID = strings.TrimSpace(input.SourceTurnID)
	if h == nil || h.store == nil || h.eventSubscriptions == nil || input.WorkspaceID == "" || input.SubscriberAgentSessionID == "" || input.SourceAgentSessionID == "" {
		return storesqlite.EventSubscription{}, ErrInvalidArgument
	}
	if !IsSupportedEventType(input.EventType) {
		return storesqlite.EventSubscription{}, ErrEventTypeUnsupported
	}
	if input.SubscriberAgentSessionID == input.SourceAgentSessionID {
		return storesqlite.EventSubscription{}, ErrInvalidArgument
	}
	if input.SubscriptionID == "" {
		input.SubscriptionID = uuid.NewString()
	}
	for _, sessionID := range []string{input.SubscriberAgentSessionID, input.SourceAgentSessionID} {
		if _, found, err := h.store.GetSession(ctx, input.WorkspaceID, sessionID); err != nil {
			return storesqlite.EventSubscription{}, err
		} else if !found {
			return storesqlite.EventSubscription{}, ErrSessionNotFound
		}
	}
	if input.SourceTurnID != "" {
		if _, found, err := h.store.GetTurn(ctx, input.WorkspaceID, input.SourceAgentSessionID, input.SourceTurnID); err != nil {
			return storesqlite.EventSubscription{}, err
		} else if !found {
			return storesqlite.EventSubscription{}, ErrInvalidArgument
		}
	}
	created, _, err := h.eventSubscriptions.CreateEventSubscription(ctx, storesqlite.CreateEventSubscriptionInput{
		SubscriptionID: input.SubscriptionID, WorkspaceID: input.WorkspaceID,
		SubscriberAgentSessionID: input.SubscriberAgentSessionID, EventType: input.EventType, EventVersion: 1,
		SourceKind: canonical.EventSourceKindAgentTurn, SourceID: input.SourceAgentSessionID, SourceSubjectID: input.SourceTurnID,
		NowUnixMS: h.now().UnixMilli(),
	})
	return created, err
}

func (h *Host) ListEventSubscriptions(ctx context.Context, ref SessionRef) ([]storesqlite.EventSubscription, error) {
	ref.WorkspaceID, ref.AgentSessionID = strings.TrimSpace(ref.WorkspaceID), strings.TrimSpace(ref.AgentSessionID)
	if h == nil || h.eventSubscriptions == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" {
		return nil, ErrInvalidArgument
	}
	return h.eventSubscriptions.ListEventSubscriptions(ctx, ref.WorkspaceID, ref.AgentSessionID)
}

func (h *Host) CancelEventSubscription(ctx context.Context, ref SessionRef, subscriptionID string) (storesqlite.EventSubscription, error) {
	ref.WorkspaceID, ref.AgentSessionID = strings.TrimSpace(ref.WorkspaceID), strings.TrimSpace(ref.AgentSessionID)
	subscriptionID = strings.TrimSpace(subscriptionID)
	if h == nil || h.eventSubscriptions == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" || subscriptionID == "" {
		return storesqlite.EventSubscription{}, ErrInvalidArgument
	}
	subscription, found, err := h.eventSubscriptions.GetEventSubscription(ctx, ref.WorkspaceID, subscriptionID)
	if err != nil {
		return storesqlite.EventSubscription{}, err
	}
	if !found || subscription.SubscriberAgentSessionID != ref.AgentSessionID {
		return storesqlite.EventSubscription{}, ErrEventSubscriptionNotFound
	}
	updated, _, err := h.eventSubscriptions.CancelEventSubscription(ctx, ref.WorkspaceID, subscriptionID, ref.AgentSessionID, h.now().UnixMilli())
	return updated, err
}

func (h *Host) RecoverEventDeliveries(ctx context.Context) error {
	if h == nil || h.eventSubscriptions == nil {
		return nil
	}
	if _, err := h.eventSubscriptions.RequeueLeasedEventDeliveriesOnStartup(ctx, h.now().UnixMilli()); err != nil {
		return fmt.Errorf("requeue leased agent event deliveries on startup: %w", err)
	}
	for {
		processed, err := h.StepEventDeliveryWorker(ctx)
		if err != nil {
			return err
		}
		if !processed {
			return nil
		}
	}
}

func (h *Host) StepEventDeliveryWorker(ctx context.Context) (bool, error) {
	if h == nil || h.eventSubscriptions == nil {
		return false, nil
	}
	now := h.now()
	deliveries, err := h.eventSubscriptions.ListClaimableEventDeliveries(ctx, now.UnixMilli(), eventDeliveryBatchSize)
	if err != nil {
		return false, err
	}
	processed := false
	owner := strings.TrimSpace(h.eventDeliveryOwner)
	if owner == "" {
		owner = "agent-host-event-delivery"
	}
	for _, candidate := range deliveries {
		leased, claimed, claimErr := h.eventSubscriptions.ClaimEventDelivery(ctx, storesqlite.ClaimEventDeliveryInput{
			DeliveryID: candidate.DeliveryID, LeaseOwner: owner, NowUnixMS: now.UnixMilli(),
			LeaseExpiresAtUnixMS: now.Add(eventDeliveryLeaseDuration).UnixMilli(),
		})
		if claimErr != nil {
			return processed, claimErr
		}
		if !claimed {
			continue
		}
		processed = true
		if err := h.deliverEvent(ctx, leased); err != nil {
			_, _, releaseErr := h.eventSubscriptions.ReleaseEventDelivery(ctx, storesqlite.ReleaseEventDeliveryInput{
				DeliveryID: leased.DeliveryID, LeaseOwner: owner, NowUnixMS: h.now().UnixMilli(),
				NextAttemptAtUnixMS: eventDeliveryNextAttemptAt(h.now(), leased.Attempt),
				LastError:           err.Error(),
			})
			if releaseErr != nil {
				return processed, releaseErr
			}
			continue
		}
		if _, changed, err := h.eventSubscriptions.CompleteEventDelivery(ctx, leased.DeliveryID, owner, h.now().UnixMilli()); err != nil {
			return processed, err
		} else if !changed {
			return processed, storesqlite.ErrEventDeliveryLeaseLost
		}
	}
	return processed, nil
}

func (h *Host) deliverEvent(ctx context.Context, delivery storesqlite.EventDelivery) error {
	source := map[string]any{"kind": delivery.SourceKind, "id": delivery.SourceID, "subjectId": delivery.SourceSubjectID}
	if delivery.SourceKind == canonical.EventSourceKindAgentTurn {
		source["agentSessionId"], source["turnId"] = delivery.SourceID, delivery.SourceSubjectID
	}
	var data any = map[string]any{}
	if strings.TrimSpace(delivery.PayloadJSON) != "" {
		if err := json.Unmarshal([]byte(delivery.PayloadJSON), &data); err != nil {
			return fmt.Errorf("decode agent event delivery payload: %w", err)
		}
	}
	payload := map[string]any{
		"id": delivery.EventID, "type": delivery.EventType, "version": delivery.EventVersion,
		"source": source, "data": data, "directive": "continue_waiting_task",
		"subscriptionId": delivery.SubscriptionID, "deliveryId": delivery.DeliveryID,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = h.SendInput(ctx, SessionRef{WorkspaceID: delivery.WorkspaceID, AgentSessionID: delivery.SubscriberAgentSessionID}, SendInput{
		Content: []PromptContentBlock{{Type: "text", Text: string(encoded)}}, SubmissionKind: SubmissionKindEventContinuation,
		ClientSubmitID: "event-delivery:" + delivery.DeliveryID,
		Metadata:       map[string]any{"tuttiEvent": payload},
	})
	return err
}

func (h *Host) runEventDeliveryWorker(ctx context.Context) error {
	if h == nil {
		return nil
	}
	if h.scheduler == nil {
		ticker := time.NewTicker(eventDeliveryWorkerInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-ticker.C:
				if _, err := h.StepEventDeliveryWorker(ctx); err != nil {
					slog.Warn("agent event delivery step failed", "error", err)
				}
			}
		}
	}
	for {
		if err := h.scheduler.Sleep(ctx, eventDeliveryWorkerInterval); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return fmt.Errorf("agent event delivery worker scheduler: %w", err)
		}
		if _, err := h.StepEventDeliveryWorker(ctx); err != nil && !errors.Is(err, context.Canceled) {
			slog.Warn("agent event delivery step failed", "error", err)
		}
	}
}

func eventDeliveryNextAttemptAt(now time.Time, attempt int) int64 {
	if attempt < 1 {
		attempt = 1
	}
	shift := attempt - 1
	if shift > 8 {
		shift = 8
	}
	return now.Add(time.Second * time.Duration(1<<shift)).UnixMilli()
}
