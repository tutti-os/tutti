package agenttarget

import (
	"context"
	"errors"
	"fmt"
	"strings"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

var (
	ErrSystemTargetImmutable   = errors.New("system agent target is immutable")
	ErrTuttiAgentAlwaysEnabled = errors.New("tutti agent is always enabled")
)

type Service struct {
	Store                workspacedata.AgentTargetStore
	AvailabilityResolver AvailabilityResolver
}

type AvailabilityResolver interface {
	ResolveAgentTargetAvailability(context.Context, agenttargetbiz.Target) (status string, reason string, executablePath string)
}

type PutInput struct {
	Target agenttargetbiz.Target
}

type DeleteInput struct {
	ID string
}

type SetEnabledInput struct {
	ID      string
	Enabled bool
}

func (s Service) List(ctx context.Context) ([]agenttargetbiz.Target, error) {
	if s.Store == nil {
		return nil, errors.New("agent target store is not configured")
	}
	targets, err := s.Store.ListAgentTargets(ctx)
	if err != nil || s.AvailabilityResolver == nil {
		return targets, err
	}
	for index := range targets {
		launchRef, launchRefErr := agenttargetbiz.RuntimeProviderTargetRef(targets[index])
		if launchRefErr == nil && launchRef["kind"] == agenttargetbiz.LaunchRefTypeAgentExtension {
			targets[index].AvailabilityStatus, targets[index].AvailabilityReason, targets[index].ExecutablePath = s.AvailabilityResolver.ResolveAgentTargetAvailability(ctx, targets[index])
		}
	}
	return targets, nil
}

func (s Service) Put(ctx context.Context, input PutInput) (agenttargetbiz.Target, error) {
	if s.Store == nil {
		return agenttargetbiz.Target{}, errors.New("agent target store is not configured")
	}
	normalized, err := agenttargetbiz.NormalizeTarget(input.Target)
	if err != nil {
		return agenttargetbiz.Target{}, err
	}
	existing, err := s.Store.GetAgentTarget(ctx, normalized.ID)
	if err == nil && agenttargetbiz.IsSystemTarget(existing) {
		return agenttargetbiz.Target{}, ErrSystemTargetImmutable
	}
	if err != nil && !errors.Is(err, workspacedata.ErrAgentTargetNotFound) {
		return agenttargetbiz.Target{}, fmt.Errorf("get existing agent target: %w", err)
	}
	return s.Store.PutAgentTarget(ctx, normalized)
}

func (s Service) Delete(ctx context.Context, input DeleteInput) error {
	if s.Store == nil {
		return errors.New("agent target store is not configured")
	}
	existing, err := s.Store.GetAgentTarget(ctx, input.ID)
	if err != nil {
		if errors.Is(err, workspacedata.ErrAgentTargetNotFound) {
			return nil
		}
		return err
	}
	if agenttargetbiz.IsSystemTarget(existing) {
		return ErrSystemTargetImmutable
	}
	return s.Store.DeleteAgentTarget(ctx, input.ID)
}

// SetEnabled is the narrow control-plane mutation for daemon-owned system
// targets. Put and Delete intentionally keep system targets immutable; this
// method preserves every identity and launch field and changes visibility only.
func (s Service) SetEnabled(ctx context.Context, input SetEnabledInput) (agenttargetbiz.Target, error) {
	if s.Store == nil {
		return agenttargetbiz.Target{}, errors.New("agent target store is not configured")
	}
	id := strings.TrimSpace(input.ID)
	if id == "" {
		return agenttargetbiz.Target{}, fmt.Errorf("%w: id is required", agenttargetbiz.ErrInvalidTarget)
	}
	existing, err := s.Store.GetAgentTarget(ctx, id)
	if err != nil {
		return agenttargetbiz.Target{}, err
	}
	if !agenttargetbiz.IsSystemTarget(existing) {
		return agenttargetbiz.Target{}, ErrSystemTargetImmutable
	}
	if existing.ID == agenttargetbiz.IDLocalTuttiAgent && !input.Enabled {
		return agenttargetbiz.Target{}, ErrTuttiAgentAlwaysEnabled
	}
	if existing.Enabled == input.Enabled {
		return existing, nil
	}
	existing.Enabled = input.Enabled
	return s.Store.PutAgentTarget(ctx, existing)
}
