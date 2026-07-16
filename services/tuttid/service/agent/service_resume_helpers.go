package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

func (s *Service) ensureRuntimeSession(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (ProviderRuntimeSession, error) {
	ensured, err := s.ensureRuntimeSessionResult(ctx, workspaceID, agentSessionID)
	return ensured.Session, err
}

type ensuredRuntimeSession struct {
	Session ProviderRuntimeSession
}

func (s *Service) ensureRuntimeSessionResult(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (ensuredRuntimeSession, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if s.SessionReader != nil {
		if persisted, ok := s.SessionReader.GetSession(workspaceID, agentSessionID); ok && isStaleHiddenLiveModelDiscoverySession(persisted) {
			if _, err := s.Delete(ctx, workspaceID, agentSessionID); err != nil && !errors.Is(err, ErrSessionNotFound) {
				return ensuredRuntimeSession{}, err
			}
			return ensuredRuntimeSession{}, ErrSessionNotFound
		}
	}
	session, err := s.ApplicationHost().EnsureRuntimeSession(ctx, agenthost.SessionRef{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
	})
	return ensuredRuntimeSession{Session: session}, err
}

func (s *Service) resolveProviderTargetRefForResume(ctx context.Context, persisted PersistedSession) (map[string]any, error) {
	snapshot, exists, err := sessionRuntimeSnapshotFromContext(persisted.InternalRuntimeContext)
	if err != nil {
		return nil, err
	}
	if exists {
		input := CreateSessionInput{}
		if err := s.applyHarnessFromSessionRuntimeSnapshot(ctx, snapshot, &input); err != nil {
			return nil, err
		}
		return clonePayload(input.ProviderTargetRef), nil
	}
	// Legacy persisted sessions can carry the new WorkspaceAgent-shaped target
	// id without an immutable runtime snapshot. Isolated/older integrations may
	// not have the WorkspaceAgent resolver wired; preserve the target identity
	// and let the provider resume its existing session in that compatibility
	// case. Newly created WorkspaceAgent sessions always take the snapshot path
	// above.
	if strings.HasPrefix(strings.TrimSpace(persisted.AgentTargetID), workspaceAgentIDPrefix) && s.WorkspaceAgentResolver == nil {
		return nil, nil
	}
	input := CreateSessionInput{
		AgentTargetID: persisted.AgentTargetID,
		Provider:      persisted.Provider,
	}
	launch, err := s.resolveCreateSessionLaunch(ctx, persisted.WorkspaceID, &input)
	if err != nil {
		return nil, err
	}
	return clonePayload(launch.ProviderTargetRef), nil
}

func (s *Service) prepareRuntimeForResume(ctx context.Context, session PersistedSession) (preparedRuntime, error) {
	input := createSessionInputFromPersisted(session)
	snapshot, exists, err := sessionRuntimeSnapshotFromContext(session.InternalRuntimeContext)
	if err != nil {
		return preparedRuntime{}, err
	}
	if !exists {
		// Legacy sessions predate immutable runtime snapshots and retain the old
		// current-binding behavior for compatibility.
		return s.prepareRuntime(ctx, strings.TrimSpace(session.WorkspaceID), strings.TrimSpace(session.Cwd), input)
	}
	if strings.TrimSpace(session.AgentTargetID) != snapshot.AgentTargetID || strings.TrimSpace(session.Provider) != snapshot.Provider {
		return preparedRuntime{}, fmt.Errorf("%w: persisted launch identity does not match snapshot", ErrSessionRuntimeSnapshotUnavailable)
	}
	input.HarnessAgentTargetID = snapshot.HarnessAgentTargetID
	input.WorkspaceAgentRevision = snapshot.WorkspaceAgentRevision
	input.AgentName = snapshot.Name
	input.AgentPurpose = snapshot.Purpose
	input.AgentDefaultModel = snapshot.ModelDefaultModel
	input.AgentInstructions = snapshot.Instructions
	input.AgentCallConditions = append([]string(nil), snapshot.CallConditions...)
	input.AgentCapabilitiesExplicit = snapshot.CapabilitiesExplicit || len(snapshot.Skills) > 0 || len(snapshot.Tools) > 0
	input.AgentSkills = append([]string(nil), snapshot.Skills...)
	input.AgentTools = append([]string(nil), snapshot.Tools...)
	input.AgentPermissions = append([]string(nil), snapshot.Permissions...)
	if err := s.applyHarnessFromSessionRuntimeSnapshot(ctx, snapshot, &input); err != nil {
		return preparedRuntime{}, err
	}
	if strings.TrimSpace(value(input.Model)) == "" && snapshot.Model != "" {
		model := snapshot.Model
		input.Model = &model
	}
	endpoint, err := s.modelEndpointFromSessionRuntimeSnapshot(ctx, strings.TrimSpace(session.WorkspaceID), snapshot, value(input.Model))
	if err != nil {
		return preparedRuntime{}, err
	}
	return s.prepareRuntimeWithModelEndpoint(ctx, strings.TrimSpace(session.WorkspaceID), strings.TrimSpace(session.Cwd), input, endpoint)
}
