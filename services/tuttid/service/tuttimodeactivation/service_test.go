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

type memoryStore struct {
	activations map[string]activationbiz.Activation
	snapshots   map[string]activationbiz.TurnSnapshot
	accepted    map[string]bool
	setErr      error
}

func newMemoryStore() *memoryStore {
	return &memoryStore{
		activations: map[string]activationbiz.Activation{},
		snapshots:   map[string]activationbiz.TurnSnapshot{},
		accepted:    map[string]bool{},
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
	return nil
}

func activation(activationID, revisionID string, revision int64, state activationbiz.State, source activationbiz.Source) activationbiz.Activation {
	now := time.Unix(100, 0).UTC()
	return activationbiz.Activation{
		ID: activationID, WorkspaceID: "workspace-1", AgentSessionID: "session-1", CreatedAt: now, UpdatedAt: now,
		CurrentRevision: activationbiz.Revision{ID: revisionID, ActivationID: activationID, Revision: revision, State: state, Source: source, CreatedAt: now},
	}
}

type recordingPublisher struct{ updates []activationbiz.Update }

func (p *recordingPublisher) PublishTuttiModeActivationUpdated(_ context.Context, update activationbiz.Update) error {
	p.updates = append(p.updates, update)
	return nil
}

func TestSetRejectsWritesWhenTuttiModeFlagDisabled(t *testing.T) {
	t.Parallel()

	store := newMemoryStore()
	service := &Service{
		Store: store,
		FeatureFlags: func(context.Context) (map[string]bool, error) {
			return map[string]bool{}, nil
		},
	}
	input := SetInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand,
	}
	if _, err := service.Set(context.Background(), input); !errors.Is(err, ErrTuttiModeDisabled) {
		t.Fatalf("Set() with flag off error = %v, want ErrTuttiModeDisabled", err)
	}

	// Reads stay available while writes are gated.
	if _, err := service.Get(context.Background(), "workspace-1", "session-1"); err != nil {
		t.Fatalf("Get() with flag off error = %v, want nil", err)
	}
}

func TestSetAllowsWritesWhenTuttiModeFlagEnabled(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_000_000).UTC()
	store := newMemoryStore()
	ids := []string{"activation-1", "revision-1"}
	service := &Service{
		Store: store,
		FeatureFlags: func(context.Context) (map[string]bool, error) {
			return map[string]bool{TuttiModeFeatureFlag: true}, nil
		},
		Now: func() time.Time { return now },
		NewID: func() string {
			value := ids[0]
			ids = ids[1:]
			return value
		},
	}
	result, err := service.Set(context.Background(), SetInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand,
	})
	if err != nil || !result.Changed {
		t.Fatalf("Set() with flag on result = %#v error = %v, want applied change", result, err)
	}
}

func TestSetFailsClosedWhenFeatureFlagReadFails(t *testing.T) {
	t.Parallel()

	service := &Service{
		Store: newMemoryStore(),
		FeatureFlags: func(context.Context) (map[string]bool, error) {
			return nil, errors.New("preferences read failed")
		},
	}
	_, err := service.Set(context.Background(), SetInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand,
	})
	if err == nil || errors.Is(err, ErrTuttiModeDisabled) {
		t.Fatalf("Set() with flag read failure error = %v, want wrapped read error", err)
	}
}
