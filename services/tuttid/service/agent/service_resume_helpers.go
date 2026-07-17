package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"
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
	if session, ok := s.controller().Session(workspaceID, agentSessionID); ok {
		if !externalImportResumeSupported(session.RuntimeContext) {
			return ensuredRuntimeSession{}, ErrSessionNotFound
		}
		return ensuredRuntimeSession{Session: session}, nil
	}
	if s.SessionReader == nil {
		return ensuredRuntimeSession{}, ErrSessionNotFound
	}
	persisted, ok := s.SessionReader.GetSession(workspaceID, agentSessionID)
	if !ok || strings.TrimSpace(persisted.Provider) == "" {
		return ensuredRuntimeSession{}, ErrSessionNotFound
	}
	if isStaleHiddenLiveModelDiscoverySession(persisted) {
		if _, err := s.Delete(ctx, workspaceID, agentSessionID); err != nil && !errors.Is(err, ErrSessionNotFound) {
			return ensuredRuntimeSession{}, err
		}
		return ensuredRuntimeSession{}, ErrSessionNotFound
	}
	// Imported local CLI transcripts can resume in place or recreate a provider
	// session. Provider data exports explicitly opt out because their web UUID is
	// not a provider runtime session id.
	persisted = s.clampPersistedSessionReasoningEffortForResume(ctx, persisted)
	imported := strings.TrimSpace(persisted.Origin) == WorkspaceAgentSessionOriginImported
	if imported && !externalImportResumeSupported(persisted.InternalRuntimeContext) {
		return ensuredRuntimeSession{}, ErrSessionNotFound
	}
	prepared, err := s.prepareRuntimeForResume(ctx, persisted)
	if err != nil {
		return ensuredRuntimeSession{}, err
	}
	// Wait out any in-flight Claude startup so this resume never overlaps
	// another credential-touching Claude process during OAuth refresh. Released
	// as soon as the session has resumed.
	releaseStartup, err := s.awaitClaudeStartupSlot(ctx, persisted.Provider)
	if err != nil {
		return ensuredRuntimeSession{}, err
	}
	session, err := func() (ProviderRuntimeSession, error) {
		defer releaseStartup()
		runtimeContext := persistedSessionRuntimeContext(persisted)
		var providerTargetRef map[string]any
		if strings.TrimSpace(persisted.AgentTargetID) != "" {
			resolvedRef, launchErr := s.resolveProviderTargetRefForResume(ctx, persisted)
			if launchErr != nil {
				return ProviderRuntimeSession{}, launchErr
			}
			providerTargetRef = resolvedRef
		}
		return s.controller().Resume(ctx, RuntimeResumeInput{
			WorkspaceID:       strings.TrimSpace(persisted.WorkspaceID),
			AgentSessionID:    strings.TrimSpace(persisted.ID),
			AgentTargetID:     strings.TrimSpace(persisted.AgentTargetID),
			Provider:          strings.TrimSpace(persisted.Provider),
			ProviderSessionID: strings.TrimSpace(persisted.ProviderSessionID),
			Cwd:               strings.TrimSpace(prepared.Cwd),
			Env:               append([]string(nil), prepared.Env...),
			Title:             strings.TrimSpace(persisted.Title),
			Status:            persistedRuntimeResumeStatus(persisted.ActiveTurnID),
			Settings:          cloneComposerSettings(persisted.Settings),
			CreatedAtUnixMS:   persisted.CreatedAtUnixMS,
			UpdatedAtUnixMS:   persisted.UpdatedAtUnixMS,
			Visible:           boolPointer(persisted.Metadata.Visible),
			RuntimeContext:    runtimeContext,
			ProviderTargetRef: providerTargetRef,
			RecreateIfMissing: imported,
		})
	}()
	if err != nil {
		return ensuredRuntimeSession{}, normalizeRuntimeError(err)
	}
	return ensuredRuntimeSession{Session: session}, nil
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
	input.AgentDescription = snapshot.Description
	input.AgentDefaultModel = snapshot.ModelDefaultModel
	input.AgentInstructions = snapshot.Instructions
	input.AgentCallConditions = append([]string(nil), snapshot.CallConditions...)
	input.AgentCapabilitiesExplicit = snapshot.CapabilitiesExplicit || len(snapshot.Skills) > 0 || len(snapshot.Tools) > 0
	input.AgentSkills = append([]string(nil), snapshot.Skills...)
	input.AgentTools = append([]string(nil), snapshot.Tools...)
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
