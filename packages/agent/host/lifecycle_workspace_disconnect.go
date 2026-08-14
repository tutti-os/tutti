package agenthost

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// DisconnectWorkspaceRuntime releases every live provider connection in one
// Workspace while preserving canonical sessions, Controller session records,
// provider session identities, and resumable history. It never resumes a
// provider and never replays a user submission.
func (h *Host) DisconnectWorkspaceRuntime(
	ctx context.Context,
	workspaceID string,
) (DisconnectWorkspaceRuntimeResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if h == nil || h.runtime == nil || workspaceID == "" {
		return DisconnectWorkspaceRuntimeResult{}, ErrInvalidArgument
	}
	if deferred, _ := ctx.Value(workspaceRuntimeDeferredDisconnectContextKey{}).(bool); deferred {
		targeter, ok := h.runtime.(RuntimeWorkspaceDisconnectTargeter)
		if !ok {
			return DisconnectWorkspaceRuntimeResult{}, ErrWorkspaceDisconnectUnavailable
		}
		targets := targeter.SnapshotWorkspaceRuntimeDisconnectTargets(workspaceID)
		h.workspaceRuntimeAdmission.deferDisconnect(workspaceID, func(deferredCtx context.Context) {
			for _, target := range targets {
				_, _ = targeter.DisconnectRuntimeSessionTarget(deferredCtx, target)
			}
		})
		return DisconnectWorkspaceRuntimeResult{}, nil
	}
	disconnectCtx, release, err := h.workspaceRuntimeAdmission.beginDisconnect(ctx, workspaceID)
	if err != nil {
		if errors.Is(err, errWorkspaceRuntimeDisconnectReentrant) {
			h.workspaceRuntimeAdmission.deferDisconnect(workspaceID, func(deferredCtx context.Context) {
				_, _ = h.disconnectWorkspaceRuntime(deferredCtx, workspaceID)
			})
			return DisconnectWorkspaceRuntimeResult{}, nil
		}
		return DisconnectWorkspaceRuntimeResult{}, err
	}
	defer release()
	return h.disconnectWorkspaceRuntime(disconnectCtx, workspaceID)
}

func (h *Host) disconnectWorkspaceRuntime(
	ctx context.Context,
	workspaceID string,
) (DisconnectWorkspaceRuntimeResult, error) {
	runtime, ok := h.runtime.(RuntimeWorkspaceDisconnector)
	if !ok {
		return DisconnectWorkspaceRuntimeResult{}, ErrWorkspaceDisconnectUnavailable
	}

	sessions, err := runtime.WorkspaceRuntimeSessions(ctx, workspaceID)
	if err != nil {
		return DisconnectWorkspaceRuntimeResult{}, err
	}
	sort.Slice(sessions, func(i, j int) bool {
		return strings.TrimSpace(sessions[i].ID) < strings.TrimSpace(sessions[j].ID)
	})
	result := DisconnectWorkspaceRuntimeResult{}
	var failures []error
	seen := make(map[string]struct{}, len(sessions))
	for _, session := range sessions {
		sessionID := strings.TrimSpace(session.ID)
		if strings.TrimSpace(session.WorkspaceID) != workspaceID || sessionID == "" {
			continue
		}
		if _, duplicate := seen[sessionID]; duplicate {
			continue
		}
		seen[sessionID] = struct{}{}
		result.Scanned++
		ref := SessionRef{WorkspaceID: workspaceID, AgentSessionID: sessionID}
		var disconnected bool
		err := h.sessionMutationActor.Do(ctx, ref, func(actorCtx context.Context) error {
			var disconnectErr error
			disconnected, disconnectErr = runtime.DisconnectRuntimeSession(actorCtx, ref)
			return disconnectErr
		})
		if err != nil {
			result.Failed++
			failures = append(failures, fmt.Errorf("disconnect agent session %q runtime: %w", sessionID, err))
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				break
			}
			continue
		}
		if disconnected {
			result.Disconnected++
		}
	}
	return result, errors.Join(failures...)
}
