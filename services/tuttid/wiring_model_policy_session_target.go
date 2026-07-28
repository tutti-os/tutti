package main

import agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"

// modelPolicySessionTargetResolver lets the review engine resolve a session's
// agent target from the persisted activity projection when a state report
// does not carry it.
type modelPolicySessionTargetResolver struct {
	projection *agentservice.ActivityProjection
}

func (r modelPolicySessionTargetResolver) ResolveSessionAgentTarget(
	workspaceID string,
	agentSessionID string,
) (string, bool) {
	if r.projection == nil {
		return "", false
	}
	session, ok := r.projection.GetSession(workspaceID, agentSessionID)
	if !ok {
		return "", false
	}
	return session.AgentTargetID, session.AgentTargetID != ""
}
