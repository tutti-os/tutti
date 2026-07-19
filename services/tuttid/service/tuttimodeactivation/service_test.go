package tuttimodeactivation

import (
	"context"
	"errors"
	"testing"
	"time"

	activationbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeactivation"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

func TestServiceSetPublishesCommittedIndependentActivation(t *testing.T) {
	t.Parallel()
	now := time.UnixMilli(1_700_000_000_000).UTC()
	store := newMemoryStore()
	publisher := &recordingPublisher{}
	ids := []string{"activation-1", "revision-1"}
	service := &Service{Store: store, Publisher: publisher, Now: func() time.Time { return now }, NewID: func() string {
		value := ids[0]
		ids = ids[1:]
		return value
	}}

	result, err := service.Set(context.Background(), SetInput{
		WorkspaceID: " workspace-1 ", AgentSessionID: " session-1 ",
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand,
	})
	if err != nil {
		t.Fatalf("Set() error = %v", err)
	}
	if !result.Changed || result.Activation == nil || result.Activation.CurrentRevision.Revision != 1 {
		t.Fatalf("result = %#v", result)
	}
	if len(publisher.updates) != 1 || publisher.updates[0].ChangeKind != activationbiz.ChangeKindActivated {
		t.Fatalf("updates = %#v", publisher.updates)
	}
}

func TestServiceSetMapsRevisionConflict(t *testing.T) {
	t.Parallel()
	store := newMemoryStore()
	store.setErr = workspacedata.ErrTuttiModeActivationRevisionConflict
	service := &Service{Store: store}
	_, err := service.Set(context.Background(), SetInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand,
	})
	if !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("Set() error = %v, want ErrRevisionConflict", err)
	}
}

func TestServiceSetRejectsMismatchedStateAndUserSourceBeforePersistence(t *testing.T) {
	t.Parallel()
	for name, input := range map[string]SetInput{
		"active from badge removal": {
			WorkspaceID: "workspace-1", AgentSessionID: "session-1",
			State: activationbiz.StateActive, Source: activationbiz.SourceBadgeRemove,
		},
		"inactive from slash command": {
			WorkspaceID: "workspace-1", AgentSessionID: "session-1",
			State: activationbiz.StateInactive, Source: activationbiz.SourceSlashCommand,
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			store := newMemoryStore()
			_, err := (&Service{Store: store}).Set(context.Background(), input)
			if !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("Set() error = %v, want ErrInvalidInput", err)
			}
			if len(store.activations) != 0 {
				t.Fatalf("invalid transition reached persistence: %#v", store.activations)
			}
		})
	}
}

func TestServiceTurnSnapshotsDoNotReconstructFromCurrentActivation(t *testing.T) {
	t.Parallel()
	store := newMemoryStore()
	service := &Service{Store: store, Now: func() time.Time { return time.Unix(100, 0).UTC() }}

	current, err := service.SnapshotForNewTurn(context.Background(), "workspace-1", "session-1")
	if err != nil || current.State != activationbiz.StateInactive {
		t.Fatalf("SnapshotForNewTurn() = %#v, %v", current, err)
	}
	bound, changed, err := service.BindTurnSnapshot(context.Background(), "workspace-1", "session-1", "turn-1", current)
	if err != nil || !changed || bound.State != activationbiz.StateInactive {
		t.Fatalf("BindTurnSnapshot() = %#v, %v, %v", bound, changed, err)
	}
	store.activations["session-1"] = activation("activation-1", "revision-1", 1, activationbiz.StateActive, activationbiz.SourceSlashCommand)
	existing, err := service.ExistingTurnSnapshot(context.Background(), "workspace-1", "session-1", "turn-1")
	if err != nil || existing.State != activationbiz.StateInactive || existing.ActivationID != "" {
		t.Fatalf("ExistingTurnSnapshot() = %#v, %v", existing, err)
	}
}

func TestServiceExistingTurnSnapshotFailsClosedWhenBindingIsMissing(t *testing.T) {
	t.Parallel()
	service := &Service{Store: newMemoryStore()}

	_, err := service.ExistingTurnSnapshot(context.Background(), "workspace-1", "session-1", "turn-missing")
	if !errors.Is(err, ErrTurnSnapshotNotFound) {
		t.Fatalf("ExistingTurnSnapshot() error = %v, want ErrTurnSnapshotNotFound", err)
	}
}

func TestServiceAcceptTurnSnapshotConfirmsDurableAcceptedStateIdempotently(t *testing.T) {
	t.Parallel()
	store := newMemoryStore()
	service := &Service{Store: store, Now: func() time.Time { return time.Unix(100, 0).UTC() }}
	snapshot := activationbiz.SnapshotFromActivation(nil)
	if _, _, err := service.BindTurnSnapshot(context.Background(), "workspace-1", "session-1", "turn-1", snapshot); err != nil {
		t.Fatal(err)
	}
	if changed, err := service.AcceptTurnSnapshot(context.Background(), "workspace-1", "session-1", "turn-1"); err != nil || !changed {
		t.Fatalf("first accept changed=%v err=%v", changed, err)
	}
	if changed, err := service.AcceptTurnSnapshot(context.Background(), "workspace-1", "session-1", "turn-1"); err != nil || changed {
		t.Fatalf("idempotent accept changed=%v err=%v", changed, err)
	}
	if _, err := service.AcceptTurnSnapshot(context.Background(), "workspace-1", "session-1", "turn-missing"); !errors.Is(err, ErrTurnSnapshotNotFound) {
		t.Fatalf("missing accept error=%v, want ErrTurnSnapshotNotFound", err)
	}
}

func TestServiceInitialActivationPublishesOnlyAfterSessionIsReadable(t *testing.T) {
	t.Parallel()
	store := newMemoryStore()
	sessions := &memorySessionReader{existing: map[string]bool{}}
	publisher := &recordingPublisher{}
	publisher.beforePublish = func(update activationbiz.Update) {
		if !sessions.existing[update.AgentSessionID] {
			t.Fatal("activation event published before canonical session became readable")
		}
	}
	service := &Service{Store: store, Sessions: sessions, Publisher: publisher}
	result, err := service.Prepare(context.Background(), SetInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand,
	}, "")
	if err != nil || result.Activation == nil || len(publisher.updates) != 0 {
		t.Fatalf("prepare result=%#v updates=%#v error=%v", result, publisher.updates, err)
	}
	if _, err := service.Accept(context.Background(), "workspace-1", "session-1"); !errors.Is(err, ErrSessionNotCommitted) {
		t.Fatalf("accept before session error=%v, want ErrSessionNotCommitted", err)
	}
	if len(publisher.updates) != 0 {
		t.Fatalf("updates before session=%#v", publisher.updates)
	}
	sessions.existing["session-1"] = true
	if changed, err := service.Accept(context.Background(), "workspace-1", "session-1"); err != nil || !changed {
		t.Fatalf("accept changed=%v error=%v", changed, err)
	}
	if len(publisher.updates) != 1 || publisher.updates[0].AgentSessionID != "session-1" {
		t.Fatalf("updates=%#v", publisher.updates)
	}
}

func TestServiceRecoverPreparedInitialActivationFromDurableTurnBarrier(t *testing.T) {
	t.Parallel()
	store := newMemoryStore()
	sessions := &memorySessionReader{existing: map[string]bool{"session-1": true}}
	publisher := &recordingPublisher{}
	service := &Service{Store: store, Sessions: sessions, Publisher: publisher}
	result, err := service.Prepare(context.Background(), SetInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand,
	}, "turn-1")
	if err != nil || result.Activation == nil {
		t.Fatalf("prepare result=%#v error=%v", result, err)
	}
	snapshot := activationbiz.SnapshotFromActivation(result.Activation)
	if _, _, err := service.BindTurnSnapshot(context.Background(), "workspace-1", "session-1", "turn-1", snapshot); err != nil {
		t.Fatal(err)
	}
	if _, err := service.AcceptTurnSnapshot(context.Background(), "workspace-1", "session-1", "turn-1"); err != nil {
		t.Fatal(err)
	}
	if err := service.RecoverPrepared(context.Background()); err != nil {
		t.Fatalf("RecoverPrepared() error=%v", err)
	}
	if len(publisher.updates) != 1 || len(store.prepared) != 0 {
		t.Fatalf("updates=%#v prepared=%#v", publisher.updates, store.prepared)
	}
}

func TestServiceRecoverPreparedWaitsForUnknownAndProvisionalEvidence(t *testing.T) {
	t.Parallel()
	store := newMemoryStore()
	sessions := &memorySessionReader{existing: map[string]bool{"session-provisional": true}}
	publisher := &recordingPublisher{}
	service := &Service{Store: store, Sessions: sessions, Publisher: publisher}
	for sessionID, turnID := range map[string]string{
		"session-unknown":     "",
		"session-provisional": "turn-provisional",
	} {
		if _, err := service.Prepare(context.Background(), SetInput{
			WorkspaceID: "workspace-1", AgentSessionID: sessionID,
			State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand,
		}, turnID); err != nil {
			t.Fatal(err)
		}
	}
	if err := service.RecoverPrepared(context.Background()); err != nil {
		t.Fatalf("RecoverPrepared() error=%v", err)
	}
	if len(publisher.updates) != 0 || len(store.prepared) != 2 {
		t.Fatalf("updates=%#v prepared=%#v", publisher.updates, store.prepared)
	}
}

func TestServiceRecoverPreparedAbandonsDeletedSession(t *testing.T) {
	t.Parallel()
	store := newMemoryStore()
	sessions := &memorySessionReader{existing: map[string]bool{}, deleted: map[string]bool{"session-failed": true}}
	service := &Service{Store: store, Sessions: sessions, Publisher: &recordingPublisher{}}
	if _, err := service.Prepare(context.Background(), SetInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-failed",
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand,
	}, ""); err != nil {
		t.Fatal(err)
	}
	if err := service.RecoverPrepared(context.Background()); err != nil {
		t.Fatalf("RecoverPrepared() error=%v", err)
	}
	if len(store.prepared) != 0 {
		t.Fatalf("prepared=%#v", store.prepared)
	}
}

func TestServiceRecoverPreparedIsolatesRowFailuresAndContinues(t *testing.T) {
	t.Parallel()
	store := newMemoryStore()
	sessions := &memorySessionReader{
		existing: map[string]bool{
			"session-good":         true,
			"session-accept-error": true,
		},
		existsErrors: map[string]error{
			"session-exists-error": errors.New("session read failed"),
		},
		deletedErrors: map[string]error{
			"session-deleted-error": errors.New("session tombstone read failed"),
		},
	}
	store.acceptErrors["session-accept-error"] = errors.New("activation accept failed")
	publisher := &recordingPublisher{}
	service := &Service{Store: store, Sessions: sessions, Publisher: publisher}
	for _, sessionID := range []string{
		"session-deleted-error",
		"session-exists-error",
		"session-accept-error",
		"session-good",
	} {
		if _, err := service.Prepare(context.Background(), SetInput{
			WorkspaceID: "workspace-1", AgentSessionID: sessionID,
			State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand,
		}, ""); err != nil {
			t.Fatalf("Prepare(%s) error=%v", sessionID, err)
		}
	}

	if err := service.RecoverPrepared(context.Background()); err != nil {
		t.Fatalf("RecoverPrepared() error=%v, want isolated row failures", err)
	}
	if _, prepared := store.prepared["session-good"]; prepared {
		t.Fatalf("good activation remained prepared: %#v", store.prepared)
	}
	for _, sessionID := range []string{"session-deleted-error", "session-exists-error", "session-accept-error"} {
		if _, prepared := store.prepared[sessionID]; !prepared {
			t.Fatalf("failed activation %q did not remain prepared: %#v", sessionID, store.prepared)
		}
	}
	if len(publisher.updates) != 1 || publisher.updates[0].AgentSessionID != "session-good" {
		t.Fatalf("updates=%#v", publisher.updates)
	}
}

func TestServiceRecoverPreparedReturnsListFailure(t *testing.T) {
	t.Parallel()
	wantErr := errors.New("prepared activation list failed")
	store := newMemoryStore()
	store.listPreparedErr = wantErr
	service := &Service{Store: store, Sessions: &memorySessionReader{}}
	if err := service.RecoverPrepared(context.Background()); !errors.Is(err, wantErr) {
		t.Fatalf("RecoverPrepared() error=%v, want %v", err, wantErr)
	}
}

type memoryStore struct {
	activations     map[string]activationbiz.Activation
	snapshots       map[string]activationbiz.TurnSnapshot
	accepted        map[string]bool
	prepared        map[string]string
	setErr          error
	acceptErrors    map[string]error
	listPreparedErr error
}

func newMemoryStore() *memoryStore {
	return &memoryStore{
		activations:  map[string]activationbiz.Activation{},
		snapshots:    map[string]activationbiz.TurnSnapshot{},
		accepted:     map[string]bool{},
		prepared:     map[string]string{},
		acceptErrors: map[string]error{},
	}
}

func (s *memoryStore) GetTuttiModeActivation(_ context.Context, _, sessionID string) (activationbiz.Activation, bool, error) {
	value, ok := s.activations[sessionID]
	return value, ok, nil
}

func (s *memoryStore) ListTuttiModeActivations(_ context.Context, _ string, sessionIDs []string) (map[string]activationbiz.Activation, error) {
	result := map[string]activationbiz.Activation{}
	for _, id := range sessionIDs {
		if value, ok := s.activations[id]; ok {
			result[id] = value
		}
	}
	return result, nil
}

func (s *memoryStore) SetTuttiModeActivation(_ context.Context, input workspacedata.SetTuttiModeActivationInput) (activationbiz.Activation, bool, error) {
	if s.setErr != nil {
		return activationbiz.Activation{}, false, s.setErr
	}
	current, exists := s.activations[input.AgentSessionID]
	if exists && current.CurrentRevision.State == input.State {
		return current, false, nil
	}
	if !exists && input.State == activationbiz.StateInactive {
		return activationbiz.Activation{}, false, nil
	}
	revision := int64(1)
	if exists {
		revision = current.CurrentRevision.Revision + 1
		input.ActivationID = current.ID
	}
	value := activation(input.ActivationID, input.RevisionID, revision, input.State, input.Source)
	value.WorkspaceID = input.WorkspaceID
	value.AgentSessionID = input.AgentSessionID
	value.CreatedAt = input.ChangedAt
	value.UpdatedAt = input.ChangedAt
	s.activations[input.AgentSessionID] = value
	return value, true, nil
}

func (s *memoryStore) PrepareTuttiModeActivation(ctx context.Context, input workspacedata.SetTuttiModeActivationInput, initialTurnID string) (activationbiz.Activation, bool, error) {
	if current, ok := s.activations[input.AgentSessionID]; ok {
		return current, false, nil
	}
	activation, changed, err := s.SetTuttiModeActivation(ctx, input)
	if err == nil && changed {
		s.prepared[input.AgentSessionID] = initialTurnID
	}
	return activation, changed, err
}

func (s *memoryStore) AcceptTuttiModeActivation(_ context.Context, _, sessionID string, _ time.Time) (activationbiz.Activation, bool, error) {
	if err := s.acceptErrors[sessionID]; err != nil {
		return activationbiz.Activation{}, false, err
	}
	activation, exists := s.activations[sessionID]
	if !exists {
		return activationbiz.Activation{}, false, nil
	}
	if _, prepared := s.prepared[sessionID]; !prepared {
		return activation, false, nil
	}
	delete(s.prepared, sessionID)
	return activation, true, nil
}

func (s *memoryStore) AbandonTuttiModeActivation(_ context.Context, _, sessionID string) (bool, error) {
	if _, prepared := s.prepared[sessionID]; !prepared {
		return false, nil
	}
	delete(s.prepared, sessionID)
	delete(s.activations, sessionID)
	return true, nil
}

func (s *memoryStore) ListPreparedTuttiModeActivations(_ context.Context) ([]workspacedata.PreparedTuttiModeActivation, error) {
	if s.listPreparedErr != nil {
		return nil, s.listPreparedErr
	}
	result := make([]workspacedata.PreparedTuttiModeActivation, 0, len(s.prepared))
	for sessionID, turnID := range s.prepared {
		result = append(result, workspacedata.PreparedTuttiModeActivation{
			Activation: s.activations[sessionID], InitialTurnID: turnID,
		})
	}
	return result, nil
}

func (s *memoryStore) GetTuttiModeTurnSnapshot(_ context.Context, _, _, turnID string) (activationbiz.TurnSnapshot, bool, error) {
	value, ok := s.snapshots[turnID]
	return value, ok, nil
}

func (s *memoryStore) PutTuttiModeTurnSnapshot(_ context.Context, _, _, turnID string, snapshot activationbiz.TurnSnapshot, _ time.Time) (activationbiz.TurnSnapshot, bool, error) {
	if current, ok := s.snapshots[turnID]; ok {
		return current, false, nil
	}
	s.snapshots[turnID] = snapshot
	return snapshot, true, nil
}

func (s *memoryStore) AcceptTuttiModeTurnSnapshot(_ context.Context, _, _, turnID string, _ time.Time) (bool, error) {
	if _, exists := s.snapshots[turnID]; !exists || s.accepted[turnID] {
		return false, nil
	}
	s.accepted[turnID] = true
	return true, nil
}

func (s *memoryStore) IsTuttiModeTurnSnapshotAccepted(_ context.Context, _, _, turnID string) (bool, error) {
	return s.accepted[turnID], nil
}

func (s *memoryStore) AbandonTuttiModeTurnSnapshot(_ context.Context, _, _, turnID string, snapshot activationbiz.TurnSnapshot) (bool, error) {
	if current, ok := s.snapshots[turnID]; ok && current == snapshot {
		delete(s.snapshots, turnID)
		delete(s.accepted, turnID)
		return true, nil
	}
	return false, nil
}

func (s *memoryStore) DeleteTuttiModeActivationSessionState(_ context.Context, _, sessionID string) error {
	delete(s.activations, sessionID)
	delete(s.prepared, sessionID)
	return nil
}

func activation(activationID, revisionID string, revision int64, state activationbiz.State, source activationbiz.Source) activationbiz.Activation {
	now := time.Unix(100, 0).UTC()
	return activationbiz.Activation{
		ID: activationID, WorkspaceID: "workspace-1", AgentSessionID: "session-1", CreatedAt: now, UpdatedAt: now,
		CurrentRevision: activationbiz.Revision{ID: revisionID, ActivationID: activationID, Revision: revision, State: state, Source: source, CreatedAt: now},
	}
}

type memorySessionReader struct {
	existing      map[string]bool
	deleted       map[string]bool
	existsErrors  map[string]error
	deletedErrors map[string]error
}

func (r *memorySessionReader) SessionExists(_ context.Context, _, sessionID string) (bool, error) {
	if err := r.existsErrors[sessionID]; err != nil {
		return false, err
	}
	return r.existing[sessionID], nil
}

func (r *memorySessionReader) SessionDeleted(_ context.Context, _, sessionID string) (bool, error) {
	if err := r.deletedErrors[sessionID]; err != nil {
		return false, err
	}
	return r.deleted[sessionID], nil
}

type recordingPublisher struct {
	updates       []activationbiz.Update
	beforePublish func(activationbiz.Update)
}

func (p *recordingPublisher) PublishTuttiModeActivationUpdated(_ context.Context, update activationbiz.Update) error {
	if p.beforePublish != nil {
		p.beforePublish(update)
	}
	p.updates = append(p.updates, update)
	return nil
}
