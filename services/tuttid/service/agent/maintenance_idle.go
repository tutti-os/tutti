package agent

import "context"

// IdleForDataMaintenance reports whether a short maintenance batch may run
// without competing with an active Agent turn. Ready but idle runtimes do not
// block cleanup.
func (s *Service) IdleForDataMaintenance(ctx context.Context) bool {
	if s == nil || s.Runtime == nil || s.WorkspaceIDs == nil {
		return false
	}
	workspaceIDs, err := s.WorkspaceIDs(ctx)
	if err != nil {
		return false
	}
	for _, workspaceID := range workspaceIDs {
		for _, session := range s.Runtime.Sessions(workspaceID) {
			if session.TurnLifecycle != nil && session.TurnLifecycle.ActiveTurnID != nil && *session.TurnLifecycle.ActiveTurnID != "" {
				return false
			}
		}
	}
	return true
}
