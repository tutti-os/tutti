package agenthost_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	hostconformance "github.com/tutti-os/tutti/packages/agent/host/conformance"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	_ "modernc.org/sqlite"
)

func TestDeletedSessionLifecycleConformance(t *testing.T) {
	for _, scenario := range hostconformance.DeletedSessionLifecycleScenarios() {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			driver := &sqliteDeletedSessionLifecycleConformanceDriver{t: t}
			if err := hostconformance.RunDeletedSessionLifecycle(t.Context(), driver, scenario); err != nil {
				t.Fatal(err)
			}
		})
	}
}

type sqliteDeletedSessionLifecycleConformanceDriver struct {
	t       *testing.T
	host    *agenthost.Host
	store   *storesqlite.Store
	runtime *deletedSessionLifecycleRuntime
}

func (d *sqliteDeletedSessionLifecycleConformanceDriver) Reset(
	ctx context.Context,
	fixture hostconformance.Fixture,
) error {
	db, err := sql.Open(
		"sqlite",
		filepath.Join(d.t.TempDir(), "deleted-session-lifecycle-conformance.db"),
	)
	if err != nil {
		return err
	}
	d.t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	d.store = storesqlite.New(db, storesqlite.Options{})
	if err := d.store.Migrate(ctx); err != nil {
		return err
	}
	d.runtime = &deletedSessionLifecycleRuntime{
		sessions: make(map[string]agenthost.ProviderRuntimeSession),
	}
	d.host = agenthost.New(agenthost.Config{
		SessionBatchManagement: d.store,
		DeletedSessions:        d.store,
		Runtime:                d.runtime,
	})

	if fixture.Session == nil {
		return nil
	}
	seed := *fixture.Session
	kind := strings.TrimSpace(seed.Kind)
	if kind == "" {
		kind = storesqlite.SessionKindRoot
	}
	if _, err := d.store.ReportSessionState(ctx, storesqlite.SessionStateReport{
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
		d.runtime.sessions[deletedSessionLifecycleRuntimeKey(seed.WorkspaceID, seed.AgentSessionID)] =
			agenthost.ProviderRuntimeSession{
				ID:                seed.AgentSessionID,
				WorkspaceID:       seed.WorkspaceID,
				Provider:          seed.Provider,
				ProviderSessionID: seed.ProviderSessionID,
				Cwd:               seed.Cwd,
			}
	}
	return nil
}

func (d *sqliteDeletedSessionLifecycleConformanceDriver) DeleteSession(
	ctx context.Context,
	ref agenthost.SessionRef,
) (agenthost.DeleteSessionResult, error) {
	return d.host.DeleteSession(ctx, ref)
}

func (d *sqliteDeletedSessionLifecycleConformanceDriver) ListDeletedSessions(
	ctx context.Context,
	input agenthost.ListDeletedSessionsInput,
) (agenthost.DeletedSessionPage, error) {
	return d.host.ListDeletedSessions(ctx, input)
}

func (d *sqliteDeletedSessionLifecycleConformanceDriver) RestoreDeletedSession(
	ctx context.Context,
	input agenthost.RestoreDeletedSessionInput,
) (agenthost.RestoreDeletedSessionResult, error) {
	return d.host.RestoreDeletedSession(ctx, input)
}

func (d *sqliteDeletedSessionLifecycleConformanceDriver) GetCanonicalSession(
	ctx context.Context,
	ref agenthost.SessionRef,
) (hostconformance.SessionObservation, error) {
	session, found, err := d.store.GetSession(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return hostconformance.SessionObservation{}, err
	}
	if !found {
		return hostconformance.SessionObservation{}, agenthost.ErrSessionNotFound
	}
	return hostconformance.SessionObservation{
		SessionID:         session.ID,
		ProviderSessionID: session.ProviderSessionID,
		RailSectionKey:    session.RailSectionKey,
		Title:             session.Title,
		ActiveTurnID:      session.ActiveTurnID,
		Pinned:            session.PinnedAtUnixMS > 0,
	}, nil
}

func (d *sqliteDeletedSessionLifecycleConformanceDriver) Metrics() hostconformance.Metrics {
	return hostconformance.Metrics{
		StartCalls:  d.runtime.startCalls,
		ResumeCalls: d.runtime.resumeCalls,
	}
}

type deletedSessionLifecycleRuntime struct {
	agenthost.RuntimeController
	sessions    map[string]agenthost.ProviderRuntimeSession
	startCalls  int
	resumeCalls int
}

func (r *deletedSessionLifecycleRuntime) Start(
	context.Context,
	agenthost.RuntimeStartInput,
) (agenthost.RuntimeStartResult, error) {
	r.startCalls++
	return agenthost.RuntimeStartResult{}, nil
}

func (r *deletedSessionLifecycleRuntime) Resume(
	context.Context,
	agenthost.RuntimeResumeInput,
) (agenthost.ProviderRuntimeSession, error) {
	r.resumeCalls++
	return agenthost.ProviderRuntimeSession{}, nil
}

func (r *deletedSessionLifecycleRuntime) Session(
	workspaceID string,
	agentSessionID string,
) (agenthost.ProviderRuntimeSession, bool) {
	session, found := r.sessions[deletedSessionLifecycleRuntimeKey(workspaceID, agentSessionID)]
	return session, found
}

func (r *deletedSessionLifecycleRuntime) Close(
	_ context.Context,
	input agenthost.RuntimeCloseInput,
) error {
	delete(r.sessions, deletedSessionLifecycleRuntimeKey(input.WorkspaceID, input.AgentSessionID))
	return nil
}

func deletedSessionLifecycleRuntimeKey(workspaceID, agentSessionID string) string {
	return workspaceID + "\x00" + agentSessionID
}
