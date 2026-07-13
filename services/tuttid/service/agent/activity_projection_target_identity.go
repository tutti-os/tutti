package agent

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

// runtimeContextAliasedAgentTargetIDKey stores the original, pre-rewrite
// agentTargetId of a session whose id was resolved through the registry alias
// table to a locally registered target. Diagnostics only; never identity.
const runtimeContextAliasedAgentTargetIDKey = "aliasedAgentTargetId"

// runtimeContextUnresolvedAgentTargetIDKey stores the original agentTargetId
// that resolved neither as a registered target id nor as a registry alias and
// was therefore dropped. Diagnostics only; never identity.
const runtimeContextUnresolvedAgentTargetIDKey = "unresolvedAgentTargetId"

// AgentTargetResolver is the local agent target registry (the
// listAgentTargets data source). Identity decisions are made exclusively
// against this registry — never inferred from session-carried data.
type AgentTargetResolver interface {
	// GetAgentTarget looks a target up by its primary id. A miss must be
	// reported as workspacedata.ErrAgentTargetNotFound so callers can tell a
	// definitive absence apart from a transient store failure.
	GetAgentTarget(ctx context.Context, id string) (agenttargetbiz.Target, error)
	// ResolveAgentTargetAlias reverse-looks-up which registered target claims
	// the given id as an alias and returns that target's primary id.
	// Contract: cross-domain id translation is owned by the host projection
	// layer (a shared session's owner-domain agentTargetId is rewritten to the
	// caller-local id before it reaches this daemon), so this lookup is defense
	// in depth only — a hit means an upstream missed its translation and the
	// value is rewritten here without trusting anything the session says.
	ResolveAgentTargetAlias(ctx context.Context, id string) (string, bool)
}

// SetAgentTargetResolver wires the local agent target registry so the
// ingestion boundary can enforce the reference-integrity invariant: any
// persisted agentTargetId must exist locally or be empty. When no resolver is
// configured the projection cannot validate and leaves ids untouched.
func (p *ActivityProjection) SetAgentTargetResolver(resolver AgentTargetResolver) {
	if p == nil {
		return
	}
	p.agentTargetResolver = resolver
}

// projectPersistedSession applies the reference-integrity invariant when
// reading a persisted session, so pre-existing rows that were stored before
// the ingestion boundary was hardened (or that slipped in through another
// path) never project an owner-domain agentTargetId. It only remaps the
// projected id; it does not rewrite the stored row.
func (p *ActivityProjection) projectPersistedSession(ctx context.Context, session PersistedSession) PersistedSession {
	if p == nil || p.agentTargetResolver == nil {
		return session
	}
	canonical, _ := p.canonicalizeAgentTargetID(ctx, session.AgentTargetID, session.InternalRuntimeContext)
	session.AgentTargetID = canonical
	return session
}

// canonicalizeAgentTargetID enforces the reference-integrity invariant at the
// session ingestion boundary. It returns the agentTargetId to persist and the
// runtimeContext to persist alongside it (a diagnostic copy of the original id
// is stashed into runtimeContext whenever the id is rewritten or dropped).
//
// Resolution consults only the local target registry:
//  1. Empty in → empty out (nothing to validate).
//  2. No resolver configured → passthrough (cannot validate; preserve
//     existing behavior for callers that never wired the registry).
//  3. id is a registered target's primary id → keep verbatim.
//  4. id is definitively absent as a primary id but a registered target
//     claims it as an alias → rewrite to that target's primary id.
//  5. neither → drop to empty.
//  6. primary-id resolution could not be verified (transient store error) →
//     keep verbatim rather than destroy a possibly-valid local id.
func (p *ActivityProjection) canonicalizeAgentTargetID(
	ctx context.Context,
	rawID string,
	runtimeContext map[string]any,
) (string, map[string]any) {
	rawID = strings.TrimSpace(rawID)
	if rawID == "" {
		return "", runtimeContext
	}
	if p == nil || p.agentTargetResolver == nil {
		return rawID, runtimeContext
	}
	exists, verified := p.agentTargetExists(ctx, rawID)
	if exists || !verified {
		return rawID, runtimeContext
	}
	if canonicalID, ok := p.agentTargetResolver.ResolveAgentTargetAlias(ctx, rawID); ok {
		canonicalID = strings.TrimSpace(canonicalID)
		if canonicalID == "" || canonicalID == rawID {
			return rawID, runtimeContext
		}
		slog.Warn("rewrote aliased agent target id to registered target id",
			"event", "workspace.agent_session.agent_target_id.alias_rewritten",
			"original_agent_target_id", rawID,
			"canonical_agent_target_id", canonicalID,
		)
		return canonicalID, stashOriginalAgentTargetID(runtimeContext, runtimeContextAliasedAgentTargetIDKey, rawID)
	}
	slog.Warn("dropped unresolved agent target id from session",
		"event", "workspace.agent_session.agent_target_id.dropped",
		"original_agent_target_id", rawID,
	)
	return "", stashOriginalAgentTargetID(runtimeContext, runtimeContextUnresolvedAgentTargetIDKey, rawID)
}

// agentTargetExists reports whether id resolves in the local target registry.
// The second return value is false when the store could not be consulted (a
// transient error distinct from a definitive "not found"), so callers can
// avoid rewriting an id they merely failed to verify.
func (p *ActivityProjection) agentTargetExists(ctx context.Context, id string) (bool, bool) {
	target, err := p.agentTargetResolver.GetAgentTarget(ctx, id)
	if err == nil {
		return strings.TrimSpace(target.ID) != "", true
	}
	if errors.Is(err, workspacedata.ErrAgentTargetNotFound) {
		return false, true
	}
	slog.Warn("agent target registry lookup failed during session ingestion",
		"event", "workspace.agent_session.agent_target_id.lookup_failed",
		"agent_target_id", strings.TrimSpace(id),
		"error", err,
	)
	return false, false
}

// stashOriginalAgentTargetID records the original id into a diagnostic
// runtimeContext key without mutating the caller's map.
func stashOriginalAgentTargetID(runtimeContext map[string]any, key string, rawID string) map[string]any {
	rawID = strings.TrimSpace(rawID)
	if rawID == "" {
		return runtimeContext
	}
	next := clonePayload(runtimeContext)
	if next == nil {
		next = map[string]any{}
	}
	next[key] = rawID
	return next
}
