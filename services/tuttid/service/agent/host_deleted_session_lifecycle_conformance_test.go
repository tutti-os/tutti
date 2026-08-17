package agent

import (
	"context"
	"strconv"
	"strings"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	hostconformance "github.com/tutti-os/tutti/packages/agent/host/conformance"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestServiceAdapterDeletedSessionLifecycleConformance(t *testing.T) {
	for _, scenario := range hostconformance.DeletedSessionLifecycleScenarios() {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			driver := &serviceAdapterDeletedSessionLifecycleConformanceDriver{t: t}
			if err := hostconformance.RunDeletedSessionLifecycle(t.Context(), driver, scenario); err != nil {
				t.Fatal(err)
			}
		})
	}
}

// The legacyHostConformanceDriver intentionally models the old in-memory
// adapter and physically removes canonical rows. This focused driver uses the
// real tuttid Workspace store and ActivityProjection so the lossless tombstone
// capability is exercised through the current Service adapter instead.
type serviceAdapterDeletedSessionLifecycleConformanceDriver struct {
	t          *testing.T
	service    *Service
	projection *ActivityProjection
	runtime    *fakeRuntime
}

func (d *serviceAdapterDeletedSessionLifecycleConformanceDriver) Reset(
	ctx context.Context,
	fixture hostconformance.Fixture,
) error {
	store := openAgentServiceSQLiteStore(d.t)
	d.runtime = newFakeRuntime()
	d.service = newUnconfiguredIsolatedAgentService(d.runtime)
	d.projection = NewActivityProjection(store)
	d.service.SessionReader = d.projection
	d.service.SetApplicationHost(agenthost.New(agenthost.Config{
		SessionBatchManagement: d.projection,
		DeletedSessions:        d.projection,
		Runtime:                serviceHostRuntime{service: d.service},
	}))

	if fixture.Session == nil {
		return nil
	}
	seed := *fixture.Session
	if err := store.Create(ctx, workspacebiz.Summary{
		ID: seed.WorkspaceID, Name: "Deleted session conformance",
	}); err != nil {
		return err
	}
	kind := strings.TrimSpace(seed.Kind)
	if kind == "" {
		kind = agentactivitybiz.SessionKindRoot
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:          seed.WorkspaceID,
		AgentSessionID:       seed.AgentSessionID,
		Kind:                 kind,
		ParentAgentSessionID: seed.ParentAgentSessionID,
		Origin:               seed.Origin,
		Provider:             seed.Provider,
		ProviderSessionID:    seed.ProviderSessionID,
		Cwd:                  seed.Cwd,
		Title:                seed.Title,
		OccurredAtUnixMS:     10,
		CreatedAtUnixMS:      10,
	}); err != nil {
		return err
	}
	if seed.Live {
		d.runtime.sessions[seed.WorkspaceID+":"+seed.AgentSessionID] = ProviderRuntimeSession{
			ID:                seed.AgentSessionID,
			WorkspaceID:       seed.WorkspaceID,
			Provider:          seed.Provider,
			ProviderSessionID: seed.ProviderSessionID,
			Cwd:               seed.Cwd,
		}
	}
	return nil
}

func (d *serviceAdapterDeletedSessionLifecycleConformanceDriver) DeleteSession(
	ctx context.Context,
	ref agenthost.SessionRef,
) (agenthost.DeleteSessionResult, error) {
	_, canonicalFound := d.projection.GetSession(ref.WorkspaceID, ref.AgentSessionID)
	_, runtimeFound := d.runtime.Session(ref.WorkspaceID, ref.AgentSessionID)
	result, err := d.service.Delete(ctx, ref.WorkspaceID, ref.AgentSessionID)
	return agenthost.DeleteSessionResult{
		Deleted:          result.Removed,
		RuntimeClosed:    runtimeFound && result.Removed,
		CanonicalRemoved: canonicalFound && result.Removed,
		CleanupFailed:    result.CleanupFailed,
	}, err
}

func (d *serviceAdapterDeletedSessionLifecycleConformanceDriver) ListDeletedSessions(
	ctx context.Context,
	input agenthost.ListDeletedSessionsInput,
) (agenthost.DeletedSessionPage, error) {
	cursor := ""
	if input.CursorUpdatedAtUnixMS > 0 || strings.TrimSpace(input.CursorAgentSessionID) != "" {
		cursor = strconv.FormatInt(input.CursorUpdatedAtUnixMS, 10) + "|" + input.CursorAgentSessionID
	}
	page, err := d.service.ListDeletedSessions(ctx, input.WorkspaceID, ListDeletedSessionsInput{
		SearchQuery:    input.SearchQuery,
		RailSectionKey: input.RailSectionKey,
		Cursor:         cursor,
		Limit:          input.Limit,
	})
	if err != nil {
		return agenthost.DeletedSessionPage{}, err
	}
	sessions := make([]agenthost.DeletedSessionSummary, 0, len(page.Sessions))
	for _, session := range page.Sessions {
		sessions = append(sessions, agenthost.DeletedSessionSummary{
			AgentSessionID:    session.AgentSessionID,
			Title:             session.Title,
			RailSectionKey:    session.RailSectionKey,
			ProjectPath:       session.ProjectPath,
			UpdatedAtUnixMS:   session.UpdatedAtUnixMS,
			DeletedAtUnixMS:   session.DeletedAtUnixMS,
			Restorable:        session.Restorable,
			UnavailableReason: session.UnavailableReason,
		})
	}
	return agenthost.DeletedSessionPage{
		WorkspaceID:         input.WorkspaceID,
		Sessions:            sessions,
		TotalCount:          page.TotalCount,
		WorkspaceTotalCount: page.WorkspaceTotalCount,
		HasMore:             page.HasMore,
		NextCursor:          page.NextCursor,
	}, nil
}

func (d *serviceAdapterDeletedSessionLifecycleConformanceDriver) RestoreDeletedSession(
	ctx context.Context,
	input agenthost.RestoreDeletedSessionInput,
) (agenthost.RestoreDeletedSessionResult, error) {
	result, err := d.service.RestoreDeletedSession(ctx, input.WorkspaceID, input.AgentSessionID)
	if err != nil {
		return agenthost.RestoreDeletedSessionResult{}, err
	}
	restoredSessionIDs := []string(nil)
	if result.Restored {
		restoredSessionIDs = []string{input.AgentSessionID}
	}
	return agenthost.RestoreDeletedSessionResult{
		Restored: result.Restored, RestoredSessionIDs: restoredSessionIDs,
	}, nil
}

func (d *serviceAdapterDeletedSessionLifecycleConformanceDriver) GetCanonicalSession(
	_ context.Context,
	ref agenthost.SessionRef,
) (hostconformance.SessionObservation, error) {
	session, found := d.projection.GetSession(ref.WorkspaceID, ref.AgentSessionID)
	if !found {
		return hostconformance.SessionObservation{}, agenthost.ErrSessionNotFound
	}
	return legacyHostSessionObservation(sessionFromPersisted(session, true)), nil
}

func (d *serviceAdapterDeletedSessionLifecycleConformanceDriver) Metrics() hostconformance.Metrics {
	return hostconformance.Metrics{
		StartCalls:  len(d.runtime.startCalls),
		ResumeCalls: len(d.runtime.resumeCalls),
	}
}
