package agenttarget

import (
	"context"
	"errors"
	"testing"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

type agentTargetStoreStub struct {
	targets map[string]agenttargetbiz.Target
	deleted []string
}

type availabilityResolverStub struct {
	resolved []string
}

func (s *availabilityResolverStub) ResolveAgentTargetAvailability(_ context.Context, target agenttargetbiz.Target) (string, string, string) {
	s.resolved = append(s.resolved, target.ID)
	return "not_installed", "compatible_runtime_not_installed", "/resolved/bin/extension"
}

func TestServiceListResolvesOnlyExtensionTargetAvailability(t *testing.T) {
	resolver := &availabilityResolverStub{}
	store := &agentTargetStoreStub{targets: map[string]agenttargetbiz.Target{
		"builtin": {
			ID: "builtin", Provider: "codex", LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
			Name: "Codex", Enabled: true, Source: agenttargetbiz.SourceSystem,
		},
		"extension": {
			ID: "extension", Provider: "acp:gemini", LaunchRefJSON: `{"type":"agent_extension","extensionInstallationId":"gemini@1.0.0"}`,
			Name: "Gemini", Enabled: true, Source: agenttargetbiz.SourceSystem,
		},
	}}
	targets, err := (Service{Store: store, AvailabilityResolver: resolver}).List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(resolver.resolved) != 1 || resolver.resolved[0] != "extension" {
		t.Fatalf("resolved targets = %#v", resolver.resolved)
	}
	for _, target := range targets {
		if target.ID == "extension" && (target.AvailabilityStatus != "not_installed" || target.AvailabilityReason != "compatible_runtime_not_installed" || target.ExecutablePath != "/resolved/bin/extension") {
			t.Fatalf("extension availability = %#v", target)
		}
	}
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

func TestServiceKeepsTuttiAgentEnabled(t *testing.T) {
	t.Parallel()

	var original agenttargetbiz.Target
	for _, target := range agenttargetbiz.DefaultSystemTargets(100) {
		if target.ID == agenttargetbiz.IDLocalTuttiAgent {
			original = target
			break
		}
	}
	if original.ID == "" {
		t.Fatal("default Tutti Agent target not found")
	}
	store := &agentTargetStoreStub{targets: map[string]agenttargetbiz.Target{original.ID: original}}
	service := Service{Store: store}

	_, err := service.SetEnabled(context.Background(), SetEnabledInput{
		ID:      agenttargetbiz.IDLocalTuttiAgent,
		Enabled: false,
	})
	if !errors.Is(err, ErrTuttiAgentAlwaysEnabled) {
		t.Fatalf("SetEnabled() error = %v, want ErrTuttiAgentAlwaysEnabled", err)
	}
	if !store.targets[original.ID].Enabled {
		t.Fatal("Tutti Agent target was disabled")
	}
}

func TestServiceSetEnabledOnlyChangesSystemTargetVisibility(t *testing.T) {
	t.Parallel()

	var original agenttargetbiz.Target
	for _, target := range agenttargetbiz.DefaultSystemTargets(100) {
		if target.ID == agenttargetbiz.IDLocalCodex {
			original = target
			break
		}
	}
	if original.ID == "" {
		t.Fatal("default Codex target not found")
	}
	store := &agentTargetStoreStub{targets: map[string]agenttargetbiz.Target{original.ID: original}}
	service := Service{Store: store}

	updated, err := service.SetEnabled(context.Background(), SetEnabledInput{
		ID:      agenttargetbiz.IDLocalCodex,
		Enabled: false,
	})
	if err != nil {
		t.Fatalf("SetEnabled() error = %v", err)
	}
	if updated.Enabled {
		t.Fatalf("updated target = %#v, want disabled", updated)
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
