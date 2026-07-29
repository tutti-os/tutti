package agent

import (
	"context"
	"strings"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

// fakeAgentTargetRegistry models the local agent target registry including
// the alias table a shared agent's registration record will carry (the
// owner-domain agentTargetId claimed as an alias of the local registration).
type fakeAgentTargetRegistry struct {
	targets map[string]agenttargetbiz.Target
	aliases map[string]string
}

func (f fakeAgentTargetRegistry) GetAgentTarget(_ context.Context, id string) (agenttargetbiz.Target, error) {
	target, ok := f.targets[strings.TrimSpace(id)]
	if !ok {
		return agenttargetbiz.Target{}, workspacedata.ErrAgentTargetNotFound
	}
	return target, nil
}

func (f fakeAgentTargetRegistry) ResolveAgentTargetAlias(_ context.Context, id string) (string, bool) {
	canonicalID, ok := f.aliases[strings.TrimSpace(id)]
	return canonicalID, ok
}

func testSharedAgentTargetRegistry() fakeAgentTargetRegistry {
	return fakeAgentTargetRegistry{
		targets: map[string]agenttargetbiz.Target{
			agenttargetbiz.IDLocalCodex: {
				ID:            agenttargetbiz.IDLocalCodex,
				Provider:      "codex",
				LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
				Name:          "Codex",
				Enabled:       true,
				Source:        agenttargetbiz.SourceSystem,
			},
			"shared-agent:codex-1": {
				ID:            "shared-agent:codex-1",
				Provider:      "codex",
				LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
				Name:          "Shared Codex",
				Enabled:       true,
				Source:        agenttargetbiz.SourceUser,
			},
		},
		aliases: map[string]string{
			// The shared-agent registration claims its owner-domain id.
			"02fc7056aaaa4bbb8cccdddd0000eeee": "shared-agent:codex-1",
		},
	}
}

// TestActivityProjectionReportSessionStateEnforcesTargetReferenceIntegrity
// pins the WS0 invariant: every persisted session carries an agentTargetId
// that resolves in the local target registry, or none at all. Owner-domain
// ids that leak in from shared sessions are rewritten when a registered
// target claims them as an alias, or dropped, with the original value
// preserved only for diagnostics. Identity is decided exclusively against
// the registry — never inferred from session-carried data.
func TestActivityProjectionReportSessionStateEnforcesTargetReferenceIntegrity(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Workspace One"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}

	projection := NewActivityProjection(store)
	projection.SetAgentTargetResolver(testSharedAgentTargetRegistry())

	for _, tc := range []struct {
		name          string
		sessionID     string
		agentTargetID string
		wantTargetID  string
		wantStashKey  string
	}{
		{
			name:          "registered id passes through verbatim",
			sessionID:     "session-local",
			agentTargetID: agenttargetbiz.IDLocalCodex,
			wantTargetID:  agenttargetbiz.IDLocalCodex,
		},
		{
			name:          "owner-domain id rewritten via registry alias",
			sessionID:     "session-shared",
			agentTargetID: "02fc7056aaaa4bbb8cccdddd0000eeee",
			wantTargetID:  "shared-agent:codex-1",
			wantStashKey:  runtimeContextAliasedAgentTargetIDKey,
		},
		{
			name:          "unclaimed id dropped and stashed",
			sessionID:     "session-orphan",
			agentTargetID: "02fc7056aaaa4bbb8cccdddd0000ffff",
			wantTargetID:  "",
			wantStashKey:  runtimeContextUnresolvedAgentTargetIDKey,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := projection.ReportSessionState(ctx, canonical.ReportSessionStateInput{
				WorkspaceID:    "ws-1",
				AgentSessionID: tc.sessionID,
				SessionOrigin:  agentsessionstore.WorkspaceAgentSessionOriginRuntime,
				State: canonical.WorkspaceAgentSessionStateUpdate{
					AgentTargetID:    tc.agentTargetID,
					Provider:         "codex",
					CurrentPhase:     "idle",
					OccurredAtUnixMS: 1000,
				},
			}); err != nil {
				t.Fatalf("ReportSessionState error = %v", err)
			}

			session, ok := projection.GetSession("ws-1", tc.sessionID)
			if !ok {
				t.Fatalf("GetSession(%q) not found", tc.sessionID)
			}
			if session.AgentTargetID != tc.wantTargetID {
				t.Fatalf("persisted agentTargetId = %q, want %q", session.AgentTargetID, tc.wantTargetID)
			}

			if tc.wantStashKey == "" {
				for _, key := range []string{runtimeContextAliasedAgentTargetIDKey, runtimeContextUnresolvedAgentTargetIDKey} {
					if _, present := session.InternalRuntimeContext[key]; present {
						t.Fatalf("unexpected diagnostic stash %q: %#v", key, session.InternalRuntimeContext)
					}
				}
				return
			}
			stashed, _ := session.InternalRuntimeContext[tc.wantStashKey].(string)
			if stashed != tc.agentTargetID {
				t.Fatalf("runtimeContext[%q] = %q, want %q", tc.wantStashKey, stashed, tc.agentTargetID)
			}
		})
	}
}

// TestActivityProjectionProjectsLegacyOwnerDomainTargetIDAtReadTime covers the
// existing-data strategy: rows persisted before the ingestion boundary was
// hardened are re-canonicalized at read time (non-destructively), so a legacy
// owner-domain agentTargetId never reaches the projection surface.
func TestActivityProjectionProjectsLegacyOwnerDomainTargetIDAtReadTime(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Workspace One"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}

	// Seed legacy rows through a resolver-less projection: the owner-domain
	// ids land verbatim, exactly as they would have before this change.
	legacy := NewActivityProjection(store)
	const aliasedOwnerDomainID = "02fc7056aaaa4bbb8cccdddd0000eeee"
	const orphanOwnerDomainID = "02fc7056aaaa4bbb8cccdddd0000ffff"
	for sessionID, ownerDomainID := range map[string]string{
		"session-legacy-aliased": aliasedOwnerDomainID,
		"session-legacy-orphan":  orphanOwnerDomainID,
	} {
		if _, err := legacy.ReportSessionState(ctx, canonical.ReportSessionStateInput{
			WorkspaceID:    "ws-1",
			AgentSessionID: sessionID,
			SessionOrigin:  agentsessionstore.WorkspaceAgentSessionOriginRuntime,
			State: canonical.WorkspaceAgentSessionStateUpdate{
				AgentTargetID:    ownerDomainID,
				Provider:         "codex",
				CurrentPhase:     "idle",
				OccurredAtUnixMS: 1000,
			},
		}); err != nil {
			t.Fatalf("legacy ReportSessionState(%s) error = %v", sessionID, err)
		}
	}

	reader := NewActivityProjection(store)
	reader.SetAgentTargetResolver(testSharedAgentTargetRegistry())

	aliased, ok := reader.GetSession("ws-1", "session-legacy-aliased")
	if !ok {
		t.Fatalf("GetSession(aliased) not found")
	}
	if aliased.AgentTargetID != "shared-agent:codex-1" {
		t.Fatalf("projected agentTargetId = %q, want shared-agent:codex-1", aliased.AgentTargetID)
	}

	orphan, ok := reader.GetSession("ws-1", "session-legacy-orphan")
	if !ok {
		t.Fatalf("GetSession(orphan) not found")
	}
	if orphan.AgentTargetID != "" {
		t.Fatalf("projected agentTargetId = %q, want empty for unclaimed legacy id", orphan.AgentTargetID)
	}

	sessions, ok := reader.ListSessions("ws-1")
	if !ok {
		t.Fatalf("ListSessions not found")
	}
	for _, session := range sessions {
		if session.AgentTargetID == aliasedOwnerDomainID || session.AgentTargetID == orphanOwnerDomainID {
			t.Fatalf("ListSessions projected leaked owner-domain agentTargetId for %q", session.ID)
		}
	}
}

// TestActivityProjectionReportSessionStatePreservesIDsWithoutResolver keeps the
// projection backward compatible: when no target registry is wired it cannot
// validate, so ids are persisted untouched.
func TestActivityProjectionReportSessionStatePreservesIDsWithoutResolver(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Workspace One"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}

	projection := NewActivityProjection(store)

	const rawID = "02fc7056aaaa4bbb8cccdddd0000eeee"
	if _, err := projection.ReportSessionState(ctx, canonical.ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-no-resolver",
		SessionOrigin:  agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		State: canonical.WorkspaceAgentSessionStateUpdate{
			AgentTargetID:    rawID,
			Provider:         "codex",
			CurrentPhase:     "idle",
			OccurredAtUnixMS: 1000,
		},
	}); err != nil {
		t.Fatalf("ReportSessionState error = %v", err)
	}

	session, ok := projection.GetSession("ws-1", "session-no-resolver")
	if !ok {
		t.Fatalf("GetSession not found")
	}
	if session.AgentTargetID != rawID {
		t.Fatalf("persisted agentTargetId = %q, want %q (unchanged)", session.AgentTargetID, rawID)
	}
	for _, key := range []string{runtimeContextAliasedAgentTargetIDKey, runtimeContextUnresolvedAgentTargetIDKey} {
		if _, present := session.InternalRuntimeContext[key]; present {
			t.Fatalf("unexpected diagnostic stash %q without a resolver: %#v", key, session.InternalRuntimeContext)
		}
	}
}
