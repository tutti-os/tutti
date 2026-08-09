package agent

import (
	"context"
	"errors"
	"strings"
)

// CleanupPurgedSessionResources removes Tutti-owned resources after the
// canonical tombstone has been permanently purged. Soft deletion deliberately
// does not call this path because the sidecar runtime root and prompt
// attachments are part of the recoverable Session state.
func (s *Service) CleanupPurgedSessionResources(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) error {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if s == nil || workspaceID == "" || agentSessionID == "" {
		return ErrInvalidArgument
	}
	// Runtime roots and copied attachments are currently keyed only by Session
	// ID, not Workspace. The durable cleanup queue globally fences ID reuse
	// until cleanup completes; this all-Workspace check additionally protects
	// IDs that were already shared before the queue row existed. Returning
	// success retires the stale queue item without touching physical resources.
	identityReader, ok := s.SessionReader.(GlobalAgentSessionIdentityReader)
	if !ok {
		return errors.New("global agent session identity reader is unavailable")
	}
	exists, err := identityReader.AgentSessionIDExists(ctx, agentSessionID)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	runtimeErr := s.cleanupSessionResources(ctx, workspaceID, agentSessionID)
	var attachmentErr error
	if strings.TrimSpace(s.PromptAttachmentStore.RootDir) != "" {
		attachmentErr = s.PromptAttachmentStore.DeleteSessionAttachments(workspaceID, agentSessionID)
	}
	return errors.Join(runtimeErr, attachmentErr)
}
