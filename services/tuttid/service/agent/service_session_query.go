package agent

import (
	"context"
	"errors"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func (s *Service) Get(ctx context.Context, workspaceID string, agentSessionID string) (Session, error) {
	return s.get(ctx, workspaceID, agentSessionID, true)
}

type SessionDetailProjection string

const (
	SessionDetailProjectionFull             SessionDetailProjection = "full"
	SessionDetailProjectionMessageHydration SessionDetailProjection = "messageHydration"
)

func (s *Service) GetDetail(ctx context.Context, workspaceID string, agentSessionID string) (SessionDetail, error) {
	return s.GetDetailWithProjection(
		ctx,
		workspaceID,
		agentSessionID,
		SessionDetailProjectionFull,
	)
}

func (s *Service) GetDetailWithProjection(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	projection SessionDetailProjection,
) (SessionDetail, error) {
	resolveProviderCapabilities := projection != SessionDetailProjectionMessageHydration
	session, err := s.get(ctx, workspaceID, agentSessionID, resolveProviderCapabilities)
	if err != nil {
		return SessionDetail{}, err
	}
	detail := SessionDetail{
		Session:       session,
		ChildSessions: []Session{},
		Turns:         []agentactivitybiz.Turn{},
	}
	detail.EditRetry, err = s.GetEditRetryAvailability(ctx, workspaceID, agentSessionID)
	if err != nil {
		return SessionDetail{}, err
	}
	if s.TurnStore != nil {
		turns, err := s.TurnStore.ListEffectiveSessionTurns(ctx, strings.TrimSpace(workspaceID), session.ID)
		if err != nil {
			return SessionDetail{}, err
		}
		if resolveProviderCapabilities {
			for index := range turns {
				turns[index] = s.withProviderTurnForkability(
					ctx,
					workspaceID,
					session.ID,
					turns[index],
				)
			}
		}
		detail.Turns = turns
	}
	reader, ok := s.SessionReader.(ChildSessionReader)
	if !ok {
		return detail, nil
	}
	persistedChildren, err := reader.ListChildSessions(ctx, workspaceID, agentSessionID)
	if err != nil {
		return SessionDetail{}, err
	}
	children := make([]Session, 0, len(persistedChildren))
	for _, persisted := range persistedChildren {
		children = append(children, sessionFromPersisted(persisted, false))
	}
	children, err = s.withProtocolV2TurnStates(ctx, strings.TrimSpace(workspaceID), children)
	if err != nil {
		return SessionDetail{}, err
	}
	detail.ChildSessions = children
	return detail, nil
}

func (s *Service) ReadAttachment(ctx context.Context, workspaceID string, agentSessionID string, attachmentID string) (PromptAttachment, error) {
	_ = ctx
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	attachmentID = strings.TrimSpace(attachmentID)
	if workspaceID == "" || agentSessionID == "" || attachmentID == "" {
		return PromptAttachment{}, ErrInvalidArgument
	}
	store := s.PromptAttachmentStore
	if strings.TrimSpace(store.RootDir) == "" {
		return PromptAttachment{}, ErrSessionNotFound
	}
	return store.ReadAttachment(workspaceID, agentSessionID, attachmentID)
}

func (s *Service) LocalAttachmentPath(ctx context.Context, workspaceID string, agentSessionID string, attachmentID string, mimeType string) (string, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	attachmentID = strings.TrimSpace(attachmentID)
	if workspaceID == "" || agentSessionID == "" || attachmentID == "" {
		return "", ErrInvalidArgument
	}
	if _, err := s.Get(ctx, workspaceID, agentSessionID); err != nil {
		return "", err
	}
	store := s.PromptAttachmentStore
	if strings.TrimSpace(store.RootDir) == "" {
		return "", ErrSessionNotFound
	}
	return store.LocalPath(workspaceID, agentSessionID, attachmentID, mimeType)
}

func (s *Service) get(ctx context.Context, workspaceID string, agentSessionID string, resolveProviderCapabilities bool) (Session, error) {
	result, err := s.ApplicationHost().GetSession(ctx, agenthost.SessionRef{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
	})
	if err != nil {
		return Session{}, err
	}
	persisted := persistedSessionFromHost(result.Canonical)
	if !result.Live && s.SessionReader != nil && isStaleHiddenLiveModelDiscoverySession(persisted) {
		if _, err := s.Delete(ctx, workspaceID, agentSessionID); err != nil && !errors.Is(err, ErrSessionNotFound) {
			return Session{}, err
		}
		return Session{}, ErrSessionNotFound
	}
	return s.projectHostSessionResult(
		ctx,
		result.Canonical,
		result.Session,
		result.Live,
		true,
		resolveProviderCapabilities,
	)
}

func (s *Service) UpdatePin(ctx context.Context, workspaceID string, agentSessionID string, pinned bool) (Session, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	result, err := s.ApplicationHost().UpdatePin(ctx, agenthost.UpdatePinInput{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID, Pinned: pinned,
	})
	if err != nil {
		return Session{}, err
	}
	return s.projectHostSessionResult(ctx, result.Canonical, result.Session, result.Live, false, true)
}

func (s *Service) cleanupRuntime(ctx context.Context, workspaceID string, agentSessionID string) error {
	return s.cleanupRuntimeWithOptions(ctx, workspaceID, agentSessionID, false)
}

func (s *Service) cleanupRuntimeWithOptions(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	preserveRuntimeRoot bool,
) error {
	var runtimeErr error
	if s.RuntimePreparer != nil {
		runtimeErr = s.RuntimePreparer.Cleanup(ctx, runtimeprep.CleanupInput{
			WorkspaceID:         workspaceID,
			AgentSessionID:      agentSessionID,
			PreserveRuntimeRoot: preserveRuntimeRoot,
		})
	}
	if s.ModelGateway != nil {
		s.ModelGateway.Unregister(ctx, workspaceID, agentSessionID)
	}
	if s.ConnectorRuntime != nil {
		s.ConnectorRuntime.RevokeSession(workspaceID, agentSessionID)
	}
	s.connectorRoutingBaselines.clear(workspaceID, agentSessionID)
	return runtimeErr
}

func (s *Service) cleanupSessionResources(ctx context.Context, workspaceID string, agentSessionID string) error {
	return s.cleanupSessionResourcesWithOptions(ctx, workspaceID, agentSessionID, false)
}

func (s *Service) releaseSessionResourcesForRecoverableDeletion(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) error {
	return s.cleanupSessionResourcesWithOptions(ctx, workspaceID, agentSessionID, true)
}

func (s *Service) cleanupSessionResourcesWithOptions(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	preserveRuntimeRoot bool,
) error {
	runtimeErr := s.cleanupRuntimeWithOptions(ctx, workspaceID, agentSessionID, preserveRuntimeRoot)
	var agentResourceErr error
	if s.AgentSessionResourceReleaser != nil {
		releaseGlobalResources := true
		if preserveRuntimeRoot {
			identityReader, ok := s.SessionReader.(GlobalAgentSessionIdentityReader)
			if !ok {
				agentResourceErr = errors.New("global agent session identity reader is unavailable")
				releaseGlobalResources = false
			} else {
				otherLive, err := identityReader.OtherWorkspaceLiveAgentSessionIDExists(
					ctx,
					strings.TrimSpace(workspaceID),
					strings.TrimSpace(agentSessionID),
				)
				if err != nil {
					agentResourceErr = err
					releaseGlobalResources = false
				} else if otherLive {
					releaseGlobalResources = false
				}
			}
		}
		if releaseGlobalResources {
			agentResourceErr = s.AgentSessionResourceReleaser.ReleaseAgent(ctx, strings.TrimSpace(agentSessionID))
		}
	}
	return errors.Join(runtimeErr, agentResourceErr)
}

func (s *Service) SubmitInteractive(ctx context.Context, ref agenthost.InteractionRef, input agenthost.SubmitInteractiveInput) (Session, error) {
	input.Payload = clonePayload(input.Payload)
	_, err := s.ApplicationHost().SubmitInteractive(ctx, ref, input)
	if err != nil {
		return Session{}, normalizeRuntimeError(err)
	}
	return s.Get(ctx, ref.WorkspaceID, ref.AgentSessionID)
}
