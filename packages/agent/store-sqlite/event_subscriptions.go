package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

const (
	EventSubscriptionStatusActive   = "active"
	EventSubscriptionStatusMatched  = "matched"
	EventSubscriptionStatusCanceled = "canceled"
	EventDeliveryStatusPrepared     = "prepared"
	EventDeliveryStatusLeased       = "leased"
	EventDeliveryStatusCompleted    = "completed"
	EventDeliveryStatusFailed       = "failed"
)

var ErrEventDeliveryLeaseLost = errors.New("agent event delivery lease was lost")
var ErrEventSubscriptionConflict = errors.New("agent event subscription id conflicts with a different subscription")

type EventSubscription struct {
	SubscriptionID           string `json:"subscriptionId"`
	WorkspaceID              string `json:"workspaceId"`
	SubscriberAgentSessionID string `json:"subscriberAgentSessionId"`
	EventType                string `json:"eventType"`
	EventVersion             int    `json:"eventVersion"`
	SourceKind               string `json:"sourceKind"`
	SourceID                 string `json:"sourceId"`
	SourceSubjectID          string `json:"sourceSubjectId,omitempty"`
	Status                   string `json:"status"`
	MatchedEventID           string `json:"matchedEventId,omitempty"`
	CreatedAtUnixMS          int64  `json:"createdAtUnixMs"`
	UpdatedAtUnixMS          int64  `json:"updatedAtUnixMs"`
}

type CreateEventSubscriptionInput struct {
	SubscriptionID           string
	WorkspaceID              string
	SubscriberAgentSessionID string
	EventType                string
	EventVersion             int
	SourceKind               string
	SourceID                 string
	SourceSubjectID          string
	NowUnixMS                int64
}

type EventDelivery struct {
	DeliveryID               string `json:"deliveryId"`
	EventID                  string `json:"eventId"`
	SubscriptionID           string `json:"subscriptionId"`
	WorkspaceID              string `json:"workspaceId"`
	SubscriberAgentSessionID string `json:"subscriberAgentSessionId"`
	EventType                string `json:"eventType"`
	EventVersion             int    `json:"eventVersion"`
	SourceKind               string `json:"sourceKind"`
	SourceID                 string `json:"sourceId"`
	SourceSubjectID          string `json:"sourceSubjectId"`
	PayloadJSON              string `json:"payloadJson"`
	Status                   string `json:"status"`
	Attempt                  int    `json:"attempt"`
	LeaseOwner               string `json:"leaseOwner,omitempty"`
	LeaseExpiresAtUnixMS     int64  `json:"leaseExpiresAtUnixMs,omitempty"`
	NextAttemptAtUnixMS      int64  `json:"nextAttemptAtUnixMs"`
	LastError                string `json:"lastError,omitempty"`
	CreatedAtUnixMS          int64  `json:"createdAtUnixMs"`
	UpdatedAtUnixMS          int64  `json:"updatedAtUnixMs"`
	CompletedAtUnixMS        int64  `json:"completedAtUnixMs,omitempty"`
}

type ClaimEventDeliveryInput struct {
	DeliveryID           string
	LeaseOwner           string
	NowUnixMS            int64
	LeaseExpiresAtUnixMS int64
}

type ReleaseEventDeliveryInput struct {
	DeliveryID          string
	LeaseOwner          string
	NowUnixMS           int64
	NextAttemptAtUnixMS int64
	LastError           string
	Failed              bool
}

func (s *Store) CreateEventSubscription(ctx context.Context, input CreateEventSubscriptionInput) (EventSubscription, bool, error) {
	input.SubscriptionID = strings.TrimSpace(input.SubscriptionID)
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.SubscriberAgentSessionID = strings.TrimSpace(input.SubscriberAgentSessionID)
	input.EventType = strings.TrimSpace(input.EventType)
	input.SourceKind = strings.TrimSpace(input.SourceKind)
	input.SourceID = strings.TrimSpace(input.SourceID)
	input.SourceSubjectID = strings.TrimSpace(input.SourceSubjectID)
	if input.SubscriptionID == "" || input.WorkspaceID == "" || input.SubscriberAgentSessionID == "" || input.EventType == "" || input.EventVersion <= 0 || input.SourceKind == "" || input.SourceID == "" || input.NowUnixMS <= 0 {
		return EventSubscription{}, false, errors.New("event subscription identity, sessions, type, and time are required")
	}
	result, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO workspace_agent_event_subscriptions
(subscription_id,workspace_id,subscriber_agent_session_id,event_type,event_version,source_kind,source_id,source_subject_id,status,created_at_unix_ms,updated_at_unix_ms)
VALUES (?,?,?,?,?,?,?,?,?,?,?)`, input.SubscriptionID, input.WorkspaceID, input.SubscriberAgentSessionID, input.EventType, input.EventVersion, input.SourceKind, input.SourceID, nullString(input.SourceSubjectID), EventSubscriptionStatusActive, input.NowUnixMS, input.NowUnixMS)
	if err != nil {
		return EventSubscription{}, false, fmt.Errorf("create agent event subscription: %w", err)
	}
	created, err := rowsWereAffected(result, "create agent event subscription")
	if err != nil {
		return EventSubscription{}, false, err
	}
	subscription, found, err := s.GetEventSubscription(ctx, input.WorkspaceID, input.SubscriptionID)
	if err != nil {
		return EventSubscription{}, false, err
	}
	if !found || subscription.SubscriberAgentSessionID != input.SubscriberAgentSessionID ||
		subscription.EventType != input.EventType || subscription.EventVersion != input.EventVersion ||
		subscription.SourceKind != input.SourceKind || subscription.SourceID != input.SourceID ||
		subscription.SourceSubjectID != input.SourceSubjectID {
		return EventSubscription{}, false, ErrEventSubscriptionConflict
	}
	return subscription, created, nil
}

func (s *Store) GetEventSubscription(ctx context.Context, workspaceID, subscriptionID string) (EventSubscription, bool, error) {
	row := s.db.QueryRowContext(ctx, `SELECT subscription_id,workspace_id,subscriber_agent_session_id,event_type,event_version,source_kind,source_id,source_subject_id,status,matched_event_id,created_at_unix_ms,updated_at_unix_ms
FROM workspace_agent_event_subscriptions WHERE workspace_id=? AND subscription_id=?`, strings.TrimSpace(workspaceID), strings.TrimSpace(subscriptionID))
	subscription, err := scanEventSubscription(row)
	if errors.Is(err, sql.ErrNoRows) {
		return EventSubscription{}, false, nil
	}
	return subscription, err == nil, err
}

func (s *Store) ListEventSubscriptions(ctx context.Context, workspaceID, subscriberAgentSessionID string) ([]EventSubscription, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT subscription_id,workspace_id,subscriber_agent_session_id,event_type,event_version,source_kind,source_id,source_subject_id,status,matched_event_id,created_at_unix_ms,updated_at_unix_ms
FROM workspace_agent_event_subscriptions WHERE workspace_id=? AND subscriber_agent_session_id=? ORDER BY created_at_unix_ms DESC,subscription_id`, strings.TrimSpace(workspaceID), strings.TrimSpace(subscriberAgentSessionID))
	if err != nil {
		return nil, fmt.Errorf("list agent event subscriptions: %w", err)
	}
	defer rows.Close()
	result := []EventSubscription{}
	for rows.Next() {
		item, scanErr := scanEventSubscription(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *Store) CancelEventSubscription(ctx context.Context, workspaceID, subscriptionID, subscriberAgentSessionID string, now int64) (EventSubscription, bool, error) {
	result, err := s.db.ExecContext(ctx, `UPDATE workspace_agent_event_subscriptions SET status=?,updated_at_unix_ms=? WHERE workspace_id=? AND subscription_id=? AND subscriber_agent_session_id=? AND status=?`, EventSubscriptionStatusCanceled, now, strings.TrimSpace(workspaceID), strings.TrimSpace(subscriptionID), strings.TrimSpace(subscriberAgentSessionID), EventSubscriptionStatusActive)
	if err != nil {
		return EventSubscription{}, false, fmt.Errorf("cancel agent event subscription: %w", err)
	}
	changed, err := rowsWereAffected(result, "cancel agent event subscription")
	if err != nil {
		return EventSubscription{}, false, err
	}
	item, found, err := s.GetEventSubscription(ctx, workspaceID, subscriptionID)
	if err != nil || !found {
		return EventSubscription{}, false, err
	}
	return item, changed, nil
}

func (s *Store) ListClaimableEventDeliveries(ctx context.Context, now int64, limit int) ([]EventDelivery, error) {
	if limit <= 0 {
		limit = 16
	}
	rows, err := s.db.QueryContext(ctx, `SELECT delivery_id,event_id,subscription_id,workspace_id,subscriber_agent_session_id,event_type,event_version,source_kind,source_id,source_subject_id,payload_json,status,attempt,lease_owner,lease_expires_at_unix_ms,next_attempt_at_unix_ms,last_error,created_at_unix_ms,updated_at_unix_ms,completed_at_unix_ms
FROM workspace_agent_event_deliveries WHERE (status=? AND next_attempt_at_unix_ms<=?) OR (status=? AND lease_expires_at_unix_ms<=?) ORDER BY created_at_unix_ms,delivery_id LIMIT ?`, EventDeliveryStatusPrepared, now, EventDeliveryStatusLeased, now, limit)
	if err != nil {
		return nil, fmt.Errorf("list claimable agent event deliveries: %w", err)
	}
	defer rows.Close()
	result := []EventDelivery{}
	for rows.Next() {
		item, scanErr := scanEventDelivery(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *Store) GetEventDeliveryBySubscription(ctx context.Context, workspaceID, subscriptionID string) (EventDelivery, bool, error) {
	row := s.db.QueryRowContext(ctx, `SELECT delivery_id,event_id,subscription_id,workspace_id,subscriber_agent_session_id,event_type,event_version,source_kind,source_id,source_subject_id,payload_json,status,attempt,lease_owner,lease_expires_at_unix_ms,next_attempt_at_unix_ms,last_error,created_at_unix_ms,updated_at_unix_ms,completed_at_unix_ms
FROM workspace_agent_event_deliveries WHERE workspace_id=? AND subscription_id=?`, strings.TrimSpace(workspaceID), strings.TrimSpace(subscriptionID))
	item, err := scanEventDelivery(row)
	if errors.Is(err, sql.ErrNoRows) {
		return EventDelivery{}, false, nil
	}
	return item, err == nil, err
}

func (s *Store) ClaimEventDelivery(ctx context.Context, input ClaimEventDeliveryInput) (EventDelivery, bool, error) {
	result, err := s.db.ExecContext(ctx, `UPDATE workspace_agent_event_deliveries SET status=?,lease_owner=?,lease_expires_at_unix_ms=?,attempt=attempt+1,updated_at_unix_ms=? WHERE delivery_id=? AND ((status=? AND next_attempt_at_unix_ms<=?) OR (status=? AND lease_expires_at_unix_ms<=?))`, EventDeliveryStatusLeased, strings.TrimSpace(input.LeaseOwner), input.LeaseExpiresAtUnixMS, input.NowUnixMS, strings.TrimSpace(input.DeliveryID), EventDeliveryStatusPrepared, input.NowUnixMS, EventDeliveryStatusLeased, input.NowUnixMS)
	if err != nil {
		return EventDelivery{}, false, fmt.Errorf("claim agent event delivery: %w", err)
	}
	claimed, err := rowsWereAffected(result, "claim agent event delivery")
	if err != nil || !claimed {
		return EventDelivery{}, claimed, err
	}
	item, found, err := s.getEventDelivery(ctx, input.DeliveryID)
	if err != nil || !found {
		return EventDelivery{}, false, err
	}
	return item, true, nil
}

func (s *Store) CompleteEventDelivery(ctx context.Context, deliveryID, leaseOwner string, now int64) (EventDelivery, bool, error) {
	result, err := s.db.ExecContext(ctx, `UPDATE workspace_agent_event_deliveries SET status=?,lease_owner=NULL,lease_expires_at_unix_ms=NULL,updated_at_unix_ms=?,completed_at_unix_ms=? WHERE delivery_id=? AND status=? AND lease_owner=?`, EventDeliveryStatusCompleted, now, now, strings.TrimSpace(deliveryID), EventDeliveryStatusLeased, strings.TrimSpace(leaseOwner))
	if err != nil {
		return EventDelivery{}, false, fmt.Errorf("complete agent event delivery: %w", err)
	}
	changed, err := rowsWereAffected(result, "complete agent event delivery")
	if err != nil {
		return EventDelivery{}, false, err
	}
	item, found, err := s.getEventDelivery(ctx, deliveryID)
	if err != nil || !found {
		return EventDelivery{}, false, err
	}
	return item, changed, nil
}

func (s *Store) ReleaseEventDelivery(ctx context.Context, input ReleaseEventDeliveryInput) (EventDelivery, bool, error) {
	status := EventDeliveryStatusPrepared
	if input.Failed {
		status = EventDeliveryStatusFailed
	}
	result, err := s.db.ExecContext(ctx, `UPDATE workspace_agent_event_deliveries SET status=?,lease_owner=NULL,lease_expires_at_unix_ms=NULL,next_attempt_at_unix_ms=?,last_error=?,updated_at_unix_ms=? WHERE delivery_id=? AND status=? AND lease_owner=?`, status, input.NextAttemptAtUnixMS, strings.TrimSpace(input.LastError), input.NowUnixMS, strings.TrimSpace(input.DeliveryID), EventDeliveryStatusLeased, strings.TrimSpace(input.LeaseOwner))
	if err != nil {
		return EventDelivery{}, false, fmt.Errorf("release agent event delivery: %w", err)
	}
	changed, err := rowsWereAffected(result, "release agent event delivery")
	if err != nil {
		return EventDelivery{}, false, err
	}
	item, found, err := s.getEventDelivery(ctx, input.DeliveryID)
	if err != nil || !found {
		return EventDelivery{}, false, err
	}
	return item, changed, nil
}

func (s *Store) RequeueLeasedEventDeliveriesOnStartup(ctx context.Context, now int64) (int64, error) {
	result, err := s.db.ExecContext(ctx, `UPDATE workspace_agent_event_deliveries SET status=?,lease_owner=NULL,lease_expires_at_unix_ms=NULL,next_attempt_at_unix_ms=?,updated_at_unix_ms=? WHERE status=?`, EventDeliveryStatusPrepared, now, now, EventDeliveryStatusLeased)
	if err != nil {
		return 0, fmt.Errorf("requeue leased agent event deliveries: %w", err)
	}
	return result.RowsAffected()
}

func (s *Store) getEventDelivery(ctx context.Context, deliveryID string) (EventDelivery, bool, error) {
	row := s.db.QueryRowContext(ctx, `SELECT delivery_id,event_id,subscription_id,workspace_id,subscriber_agent_session_id,event_type,event_version,source_kind,source_id,source_subject_id,payload_json,status,attempt,lease_owner,lease_expires_at_unix_ms,next_attempt_at_unix_ms,last_error,created_at_unix_ms,updated_at_unix_ms,completed_at_unix_ms FROM workspace_agent_event_deliveries WHERE delivery_id=?`, strings.TrimSpace(deliveryID))
	item, err := scanEventDelivery(row)
	if errors.Is(err, sql.ErrNoRows) {
		return EventDelivery{}, false, nil
	}
	return item, err == nil, err
}

type scanner interface{ Scan(...any) error }

func scanEventSubscription(row scanner) (EventSubscription, error) {
	var item EventSubscription
	var sourceSubjectID, matchedEventID sql.NullString
	err := row.Scan(&item.SubscriptionID, &item.WorkspaceID, &item.SubscriberAgentSessionID, &item.EventType, &item.EventVersion, &item.SourceKind, &item.SourceID, &sourceSubjectID, &item.Status, &matchedEventID, &item.CreatedAtUnixMS, &item.UpdatedAtUnixMS)
	item.SourceSubjectID, item.MatchedEventID = sourceSubjectID.String, matchedEventID.String
	return item, err
}

func scanEventDelivery(row scanner) (EventDelivery, error) {
	var item EventDelivery
	var leaseOwner sql.NullString
	var leaseExpires, completedAt sql.NullInt64
	err := row.Scan(&item.DeliveryID, &item.EventID, &item.SubscriptionID, &item.WorkspaceID, &item.SubscriberAgentSessionID, &item.EventType, &item.EventVersion, &item.SourceKind, &item.SourceID, &item.SourceSubjectID, &item.PayloadJSON, &item.Status, &item.Attempt, &leaseOwner, &leaseExpires, &item.NextAttemptAtUnixMS, &item.LastError, &item.CreatedAtUnixMS, &item.UpdatedAtUnixMS, &completedAt)
	item.LeaseOwner, item.LeaseExpiresAtUnixMS, item.CompletedAtUnixMS = leaseOwner.String, leaseExpires.Int64, completedAt.Int64
	return item, err
}
