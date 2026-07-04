package agenttarget

import (
	"context"
	"errors"
	"fmt"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

var ErrSystemTargetImmutable = errors.New("system agent target is immutable")

type Service struct {
	Store workspacedata.AgentTargetStore
}

type PutInput struct {
	Target agenttargetbiz.Target
}

type DeleteInput struct {
	ID string
}

func (s Service) List(ctx context.Context) ([]agenttargetbiz.Target, error) {
	if s.Store == nil {
		return nil, errors.New("agent target store is not configured")
	}
	return s.Store.ListAgentTargets(ctx)
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
