package agentmaintenance

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

type maintenanceHostStub struct {
	inputs  []agenthost.PurgeDeletedSessionsInput
	results []agenthost.PurgeDeletedSessionsResult
}

func (s *maintenanceHostStub) PurgeDeletedSessions(_ context.Context, input agenthost.PurgeDeletedSessionsInput) (agenthost.PurgeDeletedSessionsResult, error) {
	s.inputs = append(s.inputs, input)
	if len(s.results) == 0 {
		return agenthost.PurgeDeletedSessionsResult{}, nil
	}
	result := s.results[0]
	s.results = s.results[1:]
	return result, nil
}

type maintenancePreferencesStub struct{ days int }

func (s maintenancePreferencesStub) Get(context.Context) (preferencesbiz.DesktopPreferences, error) {
	return preferencesbiz.DesktopPreferences{DeletedAgentConversationRetentionDays: s.days}, nil
}

type maintenanceStateStub struct {
	state workspacedata.AgentDataMaintenanceState
	marks []int64
}

type maintenanceCompactorStub struct {
	calls     int
	compacted bool
	err       error
}

func (s *maintenanceCompactorStub) CompactDeletedDataIfSafe(context.Context) (bool, error) {
	s.calls++
	return s.compacted, s.err
}

func (s *maintenanceStateStub) GetAgentDataMaintenanceState(context.Context) (workspacedata.AgentDataMaintenanceState, error) {
	return s.state, nil
}

func (s *maintenanceStateStub) MarkAutomaticAgentDataPurgeCompleted(_ context.Context, value int64) error {
	s.marks = append(s.marks, value)
	s.state.LastAutomaticPurgeAtUnixMS = value
	return nil
}

func TestAutomaticPurgeUsesPreferenceCutoffAndPersistentDailyLimit(t *testing.T) {
	now := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
	host := &maintenanceHostStub{results: []agenthost.PurgeDeletedSessionsResult{{
		Sessions: []storesqlite.PurgedSession{{WorkspaceID: "ws", AgentSessionID: "deleted"}},
	}}}
	state := &maintenanceStateStub{}
	service := &Service{
		Host: host, Preferences: maintenancePreferencesStub{days: 15}, State: state,
		IsIdle: func(context.Context) bool { return true }, Now: func() time.Time { return now },
	}
	result, ran, err := service.RunAutomaticOnce(context.Background())
	if err != nil || !ran || result.RemovedSessions != 1 {
		t.Fatalf("RunAutomaticOnce() result=%#v ran=%v error=%v", result, ran, err)
	}
	wantCutoff := now.Add(-15 * 24 * time.Hour).UnixMilli()
	if len(host.inputs) != 1 || host.inputs[0].CutoffUnixMS != wantCutoff || len(state.marks) != 1 {
		t.Fatalf("inputs=%#v marks=%v", host.inputs, state.marks)
	}
	if _, ran, err := service.RunAutomaticOnce(context.Background()); err != nil || ran {
		t.Fatalf("second RunAutomaticOnce() ran=%v error=%v", ran, err)
	}
}

func TestAutomaticPurgeDoesNotMarkCompletionWhenWorkStartsBetweenBatches(t *testing.T) {
	now := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
	host := &maintenanceHostStub{results: []agenthost.PurgeDeletedSessionsResult{{
		Sessions: []storesqlite.PurgedSession{{WorkspaceID: "ws", AgentSessionID: "deleted"}},
		HasMore:  true,
	}}}
	state := &maintenanceStateStub{}
	idleChecks := 0
	service := &Service{
		Host: host, Preferences: maintenancePreferencesStub{days: 30}, State: state,
		IsIdle: func(context.Context) bool {
			idleChecks++
			return idleChecks <= 3
		},
		Now: func() time.Time { return now },
	}
	result, ran, err := service.RunAutomaticOnce(context.Background())
	if err != nil || !ran || result.RemovedSessions != 1 {
		t.Fatalf("RunAutomaticOnce() result=%#v ran=%v error=%v", result, ran, err)
	}
	if len(state.marks) != 0 {
		t.Fatalf("automatic completion marks=%v, want none after interruption", state.marks)
	}
}

func TestAutomaticPurgeDoesNotMarkCompletionAtBatchBudget(t *testing.T) {
	now := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
	results := make([]agenthost.PurgeDeletedSessionsResult, maxAutomaticBatches)
	for index := range results {
		results[index] = agenthost.PurgeDeletedSessionsResult{
			Sessions: []storesqlite.PurgedSession{{WorkspaceID: "ws", AgentSessionID: "deleted"}},
			HasMore:  true,
		}
	}
	host := &maintenanceHostStub{results: results}
	state := &maintenanceStateStub{}
	service := &Service{
		Host: host, Preferences: maintenancePreferencesStub{days: 30}, State: state,
		IsIdle: func(context.Context) bool { return true }, Now: func() time.Time { return now },
	}
	result, ran, err := service.RunAutomaticOnce(context.Background())
	if err != nil || !ran || result.RemovedSessions != maxAutomaticBatches {
		t.Fatalf("RunAutomaticOnce() result=%#v ran=%v error=%v", result, ran, err)
	}
	if len(state.marks) != 0 || len(host.inputs) != maxAutomaticBatches {
		t.Fatalf("marks=%v inputs=%d", state.marks, len(host.inputs))
	}
}

func TestManualPurgeContinuesPastAutomaticBatchBudget(t *testing.T) {
	results := make([]agenthost.PurgeDeletedSessionsResult, maxAutomaticBatches+1)
	for index := range results {
		results[index] = agenthost.PurgeDeletedSessionsResult{
			Sessions: []storesqlite.PurgedSession{{WorkspaceID: "ws", AgentSessionID: "deleted"}},
			HasMore:  index < len(results)-1,
		}
	}
	host := &maintenanceHostStub{results: results}
	service := &Service{Host: host, IsIdle: func(context.Context) bool { return true }}
	result, err := service.PurgeNow(context.Background())
	if err != nil || result.RemovedSessions != len(results) || len(host.inputs) != len(results) {
		t.Fatalf("PurgeNow() result=%#v inputs=%d error=%v", result, len(host.inputs), err)
	}
}

func TestManualPurgeRequiresIdleAndUsesAllTombstonesCutoff(t *testing.T) {
	host := &maintenanceHostStub{}
	idle := false
	service := &Service{Host: host, IsIdle: func(context.Context) bool { return idle }}
	if _, err := service.PurgeNow(context.Background()); !errors.Is(err, ErrBusy) {
		t.Fatalf("PurgeNow() error=%v, want busy", err)
	}
	idle = true
	if _, err := service.PurgeNow(context.Background()); err != nil {
		t.Fatalf("PurgeNow() error=%v", err)
	}
	if len(host.inputs) != 1 || host.inputs[0].CutoffUnixMS != math.MaxInt64 {
		t.Fatalf("inputs=%#v", host.inputs)
	}
}

func TestManualPurgeOptionallyCompactsButAutomaticPurgeDoesNot(t *testing.T) {
	manualHost := &maintenanceHostStub{}
	manualCompactor := &maintenanceCompactorStub{compacted: true}
	manualService := &Service{
		Host: manualHost, Compactor: manualCompactor, IsIdle: func(context.Context) bool { return true },
	}
	manualResult, err := manualService.PurgeNow(context.Background())
	if err != nil || manualCompactor.calls != 1 || !manualResult.DatabaseCompacted {
		t.Fatalf("manual result=%#v compactor calls=%d error=%v", manualResult, manualCompactor.calls, err)
	}

	now := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
	automaticHost := &maintenanceHostStub{results: []agenthost.PurgeDeletedSessionsResult{{
		Sessions: []storesqlite.PurgedSession{{WorkspaceID: "ws", AgentSessionID: "deleted"}},
	}}}
	automaticCompactor := &maintenanceCompactorStub{compacted: true}
	automaticService := &Service{
		Host: automaticHost, Preferences: maintenancePreferencesStub{days: 30}, State: &maintenanceStateStub{},
		Compactor: automaticCompactor, IsIdle: func(context.Context) bool { return true },
		Now: func() time.Time { return now },
	}
	if _, _, err := automaticService.RunAutomaticOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if automaticCompactor.calls != 0 {
		t.Fatalf("automatic compactor calls=%d, want 0", automaticCompactor.calls)
	}
}

func TestManualPurgeKeepsCommittedResultWhenOptionalCompactionFails(t *testing.T) {
	compactor := &maintenanceCompactorStub{err: errors.New("compaction unavailable")}
	service := &Service{
		Host: &maintenanceHostStub{results: []agenthost.PurgeDeletedSessionsResult{{
			Sessions: []storesqlite.PurgedSession{{WorkspaceID: "ws", AgentSessionID: "deleted"}},
		}}},
		Compactor: compactor,
		IsIdle:    func(context.Context) bool { return true },
	}
	result, err := service.PurgeNow(context.Background())
	if err != nil || result.RemovedSessions != 1 || result.DatabaseCompacted || compactor.calls != 1 {
		t.Fatalf("PurgeNow() result=%#v compactor calls=%d error=%v", result, compactor.calls, err)
	}
}
