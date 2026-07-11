package agenttarget

import (
	"context"
	"errors"
	"testing"
	"time"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

type agentTargetStoreStub struct {
	targets map[string]agenttargetbiz.Target
	deleted []string
}

func (s *agentTargetStoreStub) ListAgentTargets(context.Context) ([]agenttargetbiz.Target, error) {
	result := make([]agenttargetbiz.Target, 0, len(s.targets))
	for _, target := range s.targets {
		result = append(result, target)
	}
	return result, nil
}

func (s *agentTargetStoreStub) GetAgentTarget(_ context.Context, id string) (agenttargetbiz.Target, error) {
	target, ok := s.targets[id]
	if !ok {
		return agenttargetbiz.Target{}, workspacedata.ErrAgentTargetNotFound
	}
	return target, nil
}

func (s *agentTargetStoreStub) PutAgentTarget(_ context.Context, target agenttargetbiz.Target) (agenttargetbiz.Target, error) {
	if s.targets == nil {
		s.targets = map[string]agenttargetbiz.Target{}
	}
	s.targets[target.ID] = target
	return target, nil
}

func (s *agentTargetStoreStub) DeleteAgentTarget(_ context.Context, id string) error {
	delete(s.targets, id)
	s.deleted = append(s.deleted, id)
	return nil
}

func TestServiceRejectsSystemAgentTargetMutation(t *testing.T) {
	t.Parallel()

	store := &agentTargetStoreStub{
		targets: map[string]agenttargetbiz.Target{
			agenttargetbiz.IDLocalCodex: {
				ID:            agenttargetbiz.IDLocalCodex,
				Provider:      "codex",
				LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
				Name:          "Codex",
				Enabled:       true,
				Source:        agenttargetbiz.SourceSystem,
			},
		},
	}
	service := Service{Store: store}

	_, err := service.Put(context.Background(), PutInput{
		Target: agenttargetbiz.Target{
			ID:            agenttargetbiz.IDLocalCodex,
			Provider:      "codex",
			LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
			Name:          "Renamed Codex",
			Enabled:       false,
			Source:        agenttargetbiz.SourceSystem,
		},
	})
	if !errors.Is(err, ErrSystemTargetImmutable) {
		t.Fatalf("Put() error = %v, want ErrSystemTargetImmutable", err)
	}

	err = service.Delete(context.Background(), DeleteInput{ID: agenttargetbiz.IDLocalCodex})
	if !errors.Is(err, ErrSystemTargetImmutable) {
		t.Fatalf("Delete() error = %v, want ErrSystemTargetImmutable", err)
	}
	if len(store.deleted) != 0 {
		t.Fatalf("deleted = %#v, want none", store.deleted)
	}
}

func TestServiceAllowsUserAgentTargetMutation(t *testing.T) {
	t.Parallel()

	store := &agentTargetStoreStub{
		targets: map[string]agenttargetbiz.Target{},
	}
	service := Service{Store: store}
	target, err := service.Put(context.Background(), PutInput{
		Target: agenttargetbiz.Target{
			ID:            "custom-codex",
			Provider:      "codex",
			LaunchRefJSON: `{"type":"local_cli","provider":"codex"}`,
			Name:          "Custom Codex",
			Enabled:       true,
			Source:        agenttargetbiz.SourceUser,
		},
	})
	if err != nil {
		t.Fatalf("Put() error = %v", err)
	}
	if target.ID != "custom-codex" {
		t.Fatalf("Put() id = %q, want custom-codex", target.ID)
	}

	if err := service.Delete(context.Background(), DeleteInput{ID: "custom-codex"}); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if len(store.deleted) != 1 || store.deleted[0] != "custom-codex" {
		t.Fatalf("deleted = %#v, want custom-codex", store.deleted)
	}
}

func TestServiceSetEnabledOnlyChangesSystemTargetVisibility(t *testing.T) {
	t.Parallel()

	original := agenttargetbiz.DefaultSystemTargets(100)[2]
	store := &agentTargetStoreStub{targets: map[string]agenttargetbiz.Target{original.ID: original}}
	service := Service{
		Store: store,
		Now:   func() time.Time { return time.UnixMilli(200) },
	}

	updated, err := service.SetEnabled(context.Background(), SetEnabledInput{
		ID:      agenttargetbiz.IDLocalTuttiAgent,
		Enabled: false,
	})
	if err != nil {
		t.Fatalf("SetEnabled() error = %v", err)
	}
	if updated.Enabled || updated.UpdatedAtUnixMS != 200 {
		t.Fatalf("updated target = %#v, want disabled at 200", updated)
	}
	if updated.ID != original.ID || updated.Provider != original.Provider || updated.LaunchRefJSON != original.LaunchRefJSON || updated.Source != original.Source || updated.CreatedAtUnixMS != original.CreatedAtUnixMS {
		t.Fatalf("SetEnabled() mutated system identity: before=%#v after=%#v", original, updated)
	}
}

func TestServiceSetEnabledRejectsUserTarget(t *testing.T) {
	t.Parallel()

	store := &agentTargetStoreStub{targets: map[string]agenttargetbiz.Target{
		"custom-codex": {
			ID:            "custom-codex",
			Provider:      "codex",
			LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
			Name:          "Custom Codex",
			Enabled:       true,
			Source:        agenttargetbiz.SourceUser,
		},
	}}
	_, err := (Service{Store: store}).SetEnabled(context.Background(), SetEnabledInput{
		ID:      "custom-codex",
		Enabled: false,
	})
	if !errors.Is(err, ErrSystemTargetImmutable) {
		t.Fatalf("SetEnabled() error = %v, want ErrSystemTargetImmutable", err)
	}
	if !store.targets["custom-codex"].Enabled {
		t.Fatal("user target was mutated")
	}
}
