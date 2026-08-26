package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/titletext"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

type fakeRuntime struct {
	mu                      sync.Mutex
	nextID                  int
	canResumeCalls          []RuntimeResumeInput
	canResumeHook           func(RuntimeResumeInput) bool
	cancelCalls             []RuntimeCancelInput
	cancelErr               error
	cancelResult            RuntimeCancelResult
	cancelResultSet         bool
	closeErr                error
	closeCalls              []RuntimeCloseInput
	execErr                 error
	execHook                func(RuntimeExecInput) (RuntimeExecResult, error)
	execCalls               []RuntimeExecInput
	guidanceTargetMismatch  bool
	guidanceTarget          string
	guidanceProviderCalls   int
	provenanceErr           error
	provenanceHook          func(RuntimeSubmitProvenanceInput) error
	provenanceCalls         []RuntimeSubmitProvenanceInput
	goalControlCalls        []RuntimeGoalControlInput
	goalControlHook         func(context.Context, RuntimeGoalControlInput) (RuntimeGoalControlResult, error)
	goalReconcileCalls      []RuntimeGoalControlInput
	goalReconcileHook       func(context.Context, RuntimeGoalControlInput) (RuntimeGoalReconcileResult, error)
	goalRecoveryPolicyHook  func(context.Context, RuntimeGoalControlInput) (RuntimeGoalRecoveryPolicy, error)
	goalGenerationFences    []RuntimeGoalGenerationFenceInput
	goalGenerationFenceHook func(context.Context, RuntimeGoalGenerationFenceInput) error
	resumeErr               error
	resumeCalls             []RuntimeResumeInput
	sessions                map[string]ProviderRuntimeSession
	disconnectedSessions    map[string]bool
	submitInteractiveCalls  []RuntimeSubmitInteractiveInput
	submitInteractiveErr    error
	interactiveDisposition  RuntimeInteractiveDisposition
	startErr                error
	startCalls              []RuntimeStartInput
	startHook               func(RuntimeStartInput, ProviderRuntimeSession) ProviderRuntimeSession
	publishInitCalls        []RuntimeSessionInitializationPublishInput
	publishInitHook         func(RuntimeSessionInitializationPublishInput, ProviderRuntimeSession) error
	pendingInits            map[string]bool
	updateSettingsCalls     []RuntimeUpdateSettingsInput
	closeHook               func(RuntimeCloseInput)
	validateErr             error
	validateCalls           []RuntimeExecInput
}

type fakeAgentTargetStore struct {
	err     error
	targets map[string]agenttargetbiz.Target
}

type fakeAgentComposerDefaultsReader map[string]preferencesbiz.AgentComposerDefaults

func (f fakeAgentComposerDefaultsReader) GetAgentComposerDefaultsForTarget(_ context.Context, agentTargetID string) (preferencesbiz.AgentComposerDefaults, error) {
	return f[strings.TrimSpace(agentTargetID)], nil
}

type fakeDesktopPreferencesReader struct {
	preferences preferencesbiz.DesktopPreferences
	err         error
}

func (f fakeDesktopPreferencesReader) Get(context.Context) (preferencesbiz.DesktopPreferences, error) {
	return f.preferences, f.err
}

func (f fakeAgentTargetStore) GetAgentTarget(_ context.Context, id string) (agenttargetbiz.Target, error) {
	if f.err != nil {
		return agenttargetbiz.Target{}, f.err
	}
	target, ok := f.targets[strings.TrimSpace(id)]
	if !ok {
		return agenttargetbiz.Target{}, workspacedata.ErrAgentTargetNotFound
	}
	return target, nil
}

type fakeRuntimePreparer struct {
	result       runtimeprep.PreparedRuntime
	err          error
	input        *runtimeprep.PrepareInput
	cleanupCalls *[]runtimeprep.CleanupInput
}

func (f fakeRuntimePreparer) Prepare(_ context.Context, input runtimeprep.PrepareInput) (runtimeprep.PreparedRuntime, error) {
	if f.input != nil {
		*f.input = input
	}
	return f.result, f.err
}

func (f fakeRuntimePreparer) Cleanup(_ context.Context, input runtimeprep.CleanupInput) error {
	if f.cleanupCalls != nil {
		*f.cleanupCalls = append(*f.cleanupCalls, input)
	}
	return nil
}

type fakeSkillBundleRenderer struct {
	fakeRuntimePreparer
	bundle runtimeprep.SkillBundle
	err    error
	input  *runtimeprep.PrepareInput
}

func (f fakeSkillBundleRenderer) RenderSkillBundle(_ context.Context, input runtimeprep.PrepareInput) (runtimeprep.SkillBundle, error) {
	if f.input != nil {
		*f.input = input
	}
	return f.bundle, f.err
}

type fakeModelCatalog struct {
	inputs *([]AgentModelCatalogInput)
	result AgentModelCatalogResult
	err    error
}

func (f fakeModelCatalog) ListModels(_ context.Context, input AgentModelCatalogInput) (AgentModelCatalogResult, error) {
	if f.inputs != nil {
		*f.inputs = append(*f.inputs, input)
	}
	return f.result, f.err
}

func openAgentServiceSQLiteStore(t *testing.T) *workspacedata.SQLiteStore {
	t.Helper()
	store, err := workspacedata.OpenSQLiteStore(filepath.Join(t.TempDir(), "tutti.sqlite"))
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	return store
}

func writeAgentServiceJSONL(t *testing.T, path string, items ...map[string]any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("create jsonl dir error = %v", err)
	}
	lines := make([]string, 0, len(items))
	for _, item := range items {
		encoded, err := json.Marshal(item)
		if err != nil {
			t.Fatalf("marshal jsonl item error = %v", err)
		}
		lines = append(lines, string(encoded))
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatalf("write jsonl error = %v", err)
	}
}

type isolatedComposerCapabilityLister struct{}

func (isolatedComposerCapabilityLister) ListComposerCapabilityOptions(
	context.Context,
	string,
	string,
	[]ComposerSkillOption,
) ([]ComposerCapabilityOption, []string) {
	return nil, nil
}

// newIsolatedAgentService keeps package tests hermetic. Tests that exercise
// capability discovery replace CapabilityLister with an explicit fixture.
func newUnconfiguredIsolatedAgentService(runtime RuntimeController) *Service {
	service := NewService(runtime)
	service.CapabilityLister = isolatedComposerCapabilityLister{}
	installFakeCanonicalSessionStore(service)
	if fake, ok := runtime.(*fakeRuntime); ok {
		reader := service.SessionReader.(*fakeSessionReader)
		for key, session := range fake.sessions {
			settings := ComposerSettings{}
			if session.Settings != nil {
				settings = *session.Settings
			}
			reader.sessions[key] = PersistedSession{
				ID: session.ID, WorkspaceID: session.WorkspaceID, Provider: session.Provider,
				ProviderSessionID: session.ProviderSessionID, AgentTargetID: session.AgentTargetID,
				Cwd: session.Cwd, Title: session.Title, Settings: settings,
			}
		}
	}
	return service
}

func newIsolatedAgentService(runtime RuntimeController) *Service {
	service := newUnconfiguredIsolatedAgentService(runtime)
	configureTestApplicationHost(service)
	return service
}

func newTestService(runtime RuntimeController) *Service {
	service := newIsolatedAgentService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: defaultTestAgentTargets()}
	return service
}

func installFakeCanonicalSessionStore(service *Service) {
	reader := &fakeSessionReader{
		sessions:    map[string]PersistedSession{},
		tombstoned:  map[string]bool{},
		deletedAt:   map[string]int64{},
		parentByKey: map[string]string{},
		children:    map[string][]PersistedSession{},
		runtime:     service.Runtime,
	}
	service.SessionInitializer = fakeSessionInitializer{reader: reader}
	service.SessionReader = reader
}

func seedPersistedLiveSettingsSession(service *Service, session ProviderRuntimeSession) {
	settings := ComposerSettings{}
	if session.Settings != nil {
		settings = *session.Settings
	}
	service.SessionReader = &fakeSessionReader{sessions: map[string]PersistedSession{
		session.WorkspaceID + ":" + session.ID: {
			ID: session.ID, WorkspaceID: session.WorkspaceID, Provider: session.Provider,
			ProviderSessionID: session.ProviderSessionID, Cwd: session.Cwd,
			RailSectionKey: "conversations", Settings: settings,
			CreatedAtUnixMS: 1, UpdatedAtUnixMS: 2, LastEventUnixMS: 2,
		},
	}}
}

func defaultTestAgentTargets() map[string]agenttargetbiz.Target {
	targets := make(map[string]agenttargetbiz.Target)
	for _, target := range agenttargetbiz.DefaultSystemTargets(0) {
		targets[target.ID] = target
	}
	return targets
}

type fakeMessageReader struct {
	lastLimit  *int
	lastTurnID *string
	page       SessionMessagesPage
}

type fakeProviderAvailabilityChecker struct {
	err           error
	providers     []string
	result        []ProviderAvailability
	invalidations []string
	callCount     int
}

func (f *fakeProviderAvailabilityChecker) ListProviderAvailability(_ context.Context, providers []string) ([]ProviderAvailability, error) {
	f.callCount++
	f.providers = append([]string(nil), providers...)
	if f.err != nil {
		return nil, f.err
	}
	return append([]ProviderAvailability(nil), f.result...), nil
}

func (f *fakeProviderAvailabilityChecker) InvalidateProviderAvailability(provider string) {
	f.invalidations = append(f.invalidations, provider)
}

type fakeSessionReader struct {
	sessions           map[string]PersistedSession
	tombstoned         map[string]bool
	deletedAt          map[string]int64
	parentByKey        map[string]string
	children           map[string][]PersistedSession
	recoverableDeleted []agentactivitybiz.DeletedSessionResource
	runtime            RuntimeController
}

func (f *fakeSessionReader) CompareAndSwapSessionRuntimeContext(
	_ context.Context,
	workspaceID string,
	sessionID string,
	expected map[string]any,
	replacement map[string]any,
) (PersistedSession, bool, error) {
	if f == nil {
		return PersistedSession{}, false, nil
	}
	key := strings.TrimSpace(workspaceID) + ":" + strings.TrimSpace(sessionID)
	session, found := f.sessions[key]
	if !found || !reflect.DeepEqual(session.InternalRuntimeContext, expected) {
		return session, false, nil
	}
	session.InternalRuntimeContext = clonePayload(replacement)
	f.sessions[key] = session
	return session, true, nil
}

type fakeSessionInitializer struct {
	err    error
	reader *fakeSessionReader
}

func (f fakeSessionInitializer) ResolveRuntimeSessionRailPlacement(
	_ context.Context,
	input agenthost.ResolveRuntimeSessionRailPlacementInput,
) (*agenthost.RailPlacement, error) {
	if input.RailPlacement != nil {
		placement := *input.RailPlacement
		return &placement, nil
	}
	if f.reader != nil {
		if existing, found := f.reader.sessions[strings.TrimSpace(input.WorkspaceID)+":"+strings.TrimSpace(input.AgentSessionID)]; found &&
			strings.TrimSpace(existing.RailSectionKey) != "" {
			kind := agenthost.RailPlacementKind(strings.TrimSpace(existing.RailSectionKind))
			if kind == "" && strings.TrimSpace(existing.RailSectionKey) == agentactivitybiz.RailSectionKeyConversations {
				kind = agenthost.RailPlacementKindConversations
			}
			return &agenthost.RailPlacement{
				Version: agenthost.RailPlacementVersion, Kind: kind,
				ProjectPath: existing.RailProjectPath, SectionKey: existing.RailSectionKey,
			}, nil
		}
	}
	section := agentactivitybiz.ClassifyRailSection(input.Cwd, input.RuntimeContext, nil)
	return &agenthost.RailPlacement{
		Version: agenthost.RailPlacementVersion, Kind: agenthost.RailPlacementKind(section.Kind),
		ProjectPath: section.ProjectPath, SectionKey: section.Key,
	}, nil
}

func (f fakeSessionInitializer) InitializeRuntimeSession(
	_ context.Context,
	session ProviderRuntimeSession,
	railPlacement *agenthost.RailPlacement,
) (PersistedSession, error) {
	if f.err != nil {
		return PersistedSession{}, f.err
	}
	settings := cloneComposerSettingsPointerValue(session.Settings)
	persisted := PersistedSession{
		ID:                     strings.TrimSpace(session.ID),
		WorkspaceID:            strings.TrimSpace(session.WorkspaceID),
		Kind:                   agentactivitybiz.SessionKindRoot,
		UserID:                 strings.TrimSpace(session.UserID),
		AgentTargetID:          strings.TrimSpace(session.AgentTargetID),
		Provider:               strings.TrimSpace(session.Provider),
		ProviderSessionID:      strings.TrimSpace(session.ProviderSessionID),
		Cwd:                    strings.TrimSpace(session.Cwd),
		RailSectionKind:        "conversations",
		RailSectionKey:         "conversations",
		Settings:               settings,
		Metadata:               agentactivitybiz.SessionMetadata{Visible: session.Visible},
		InternalRuntimeContext: clonePayload(session.RuntimeContext),
		Title:                  strings.TrimSpace(session.Title),
		PinnedAtUnixMS:         session.PinnedAtUnixMS,
		LastEventUnixMS:        session.UpdatedAtUnixMS,
		StartedAtUnixMS:        session.CreatedAtUnixMS,
		CreatedAtUnixMS:        session.CreatedAtUnixMS,
		UpdatedAtUnixMS:        session.UpdatedAtUnixMS,
	}
	if railPlacement != nil {
		persisted.RailSectionKind = strings.TrimSpace(string(railPlacement.Kind))
		persisted.RailProjectPath = strings.TrimSpace(railPlacement.ProjectPath)
		persisted.RailSectionKey = strings.TrimSpace(railPlacement.SectionKey)
	}
	if f.reader != nil {
		f.reader.sessions[persisted.WorkspaceID+":"+persisted.ID] = persisted
	}
	return persisted, nil
}

type fakeAgentSessionResourceReleaser struct {
	released []string
	err      error
}

func (f *fakeAgentSessionResourceReleaser) ReleaseAgent(_ context.Context, agentSessionID string) error {
	f.released = append(f.released, agentSessionID)
	return f.err
}

type fakeSectionReader struct {
	fakeSessionReader
	lastInput                   agentactivitybiz.ListSessionSectionInput
	lastSectionsInput           agentactivitybiz.ListSessionSectionsInput
	lastDeletionCandidatesInput agentactivitybiz.ListSessionSectionDeletionCandidatesInput
	deletionCandidates          agentactivitybiz.SessionSectionDeletionCandidates
	lastBatchDeleteInput        agentactivitybiz.DeleteSessionsBatchInput
	batchDeleteResult           agentactivitybiz.DeleteSessionsBatchResult
	batchDeleteErr              error
	batchDeleteCalls            int
	sectionBatchCalls           int
	singleSectionCalls          int
	sectionBatchErr             error
	singleSectionErr            error
	pages                       map[string]agentactivitybiz.SessionSectionPage
}

func (f *fakeSectionReader) ListSessionSection(_ context.Context, input agentactivitybiz.ListSessionSectionInput) (agentactivitybiz.SessionSectionPage, bool, error) {
	f.singleSectionCalls++
	f.lastInput = input
	if f.singleSectionErr != nil {
		return agentactivitybiz.SessionSectionPage{}, false, f.singleSectionErr
	}
	if f.pages == nil {
		return agentactivitybiz.SessionSectionPage{
			WorkspaceID: input.WorkspaceID,
			SectionKey:  input.SectionKey,
		}, true, nil
	}
	page, ok := f.pages[input.SectionKey]
	if !ok {
		return agentactivitybiz.SessionSectionPage{
			WorkspaceID: input.WorkspaceID,
			SectionKey:  input.SectionKey,
		}, true, nil
	}
	page.WorkspaceID = input.WorkspaceID
	page.SectionKey = input.SectionKey
	return page, true, nil
}

func (f *fakeSectionReader) ListSessionSections(_ context.Context, input agentactivitybiz.ListSessionSectionsInput) (agentactivitybiz.SessionSectionsPage, bool, error) {
	f.sectionBatchCalls++
	f.lastSectionsInput = input
	if f.sectionBatchErr != nil {
		return agentactivitybiz.SessionSectionsPage{}, false, f.sectionBatchErr
	}
	sections := make([]agentactivitybiz.SessionSectionPage, 0, len(input.SectionKeys))
	for _, sectionKey := range input.SectionKeys {
		page, ok := f.pages[sectionKey]
		if !ok {
			page = agentactivitybiz.SessionSectionPage{}
		}
		page.WorkspaceID = input.WorkspaceID
		page.SectionKey = sectionKey
		sections = append(sections, page)
	}
	return agentactivitybiz.SessionSectionsPage{
		WorkspaceID: input.WorkspaceID,
		Sections:    sections,
	}, true, nil
}

func (f *fakeSectionReader) ListSessionSectionDeletionCandidates(_ context.Context, input agentactivitybiz.ListSessionSectionDeletionCandidatesInput) (agentactivitybiz.SessionSectionDeletionCandidates, bool) {
	f.lastDeletionCandidatesInput = input
	result := f.deletionCandidates
	result.WorkspaceID = input.WorkspaceID
	result.SectionKey = input.SectionKey
	result.AgentTargetID = input.AgentTargetID
	result.ExcludePinned = input.ExcludePinned
	return result, true
}

func (f *fakeSectionReader) DeleteSessionsBatch(_ context.Context, input agentactivitybiz.DeleteSessionsBatchInput) (agentactivitybiz.DeleteSessionsBatchResult, error) {
	f.batchDeleteCalls++
	f.lastBatchDeleteInput = input
	return f.batchDeleteResult, f.batchDeleteErr
}

func (*fakeSectionReader) PlanDeleteSessions(_ context.Context, input agentactivitybiz.DeleteSessionsBatchInput) (agentactivitybiz.DeleteSessionsPlan, error) {
	return agentactivitybiz.DeleteSessionsPlan{WorkspaceID: input.WorkspaceID, SessionIDs: input.SessionIDs}, nil
}

func (*fakeSectionReader) PlanClearSessions(_ context.Context, workspaceID string) (agentactivitybiz.DeleteSessionsPlan, error) {
	return agentactivitybiz.DeleteSessionsPlan{WorkspaceID: workspaceID}, nil
}

type fakeUserProjectReader struct {
	projects []userprojectbiz.Project
}

func (f fakeUserProjectReader) List(context.Context) ([]userprojectbiz.Project, error) {
	return f.projects, nil
}

func (f fakeMessageReader) ListSessionMessages(
	input agentactivitybiz.ListSessionMessagesInput,
) (SessionMessagesPage, bool) {
	if f.lastLimit != nil {
		*f.lastLimit = input.Limit
	}
	if f.lastTurnID != nil {
		*f.lastTurnID = input.TurnID
	}
	if input.AgentSessionID != "session-1" {
		return SessionMessagesPage{}, false
	}
	return f.page, true
}

func newFakeRuntime() *fakeRuntime {
	return &fakeRuntime{
		sessions:             make(map[string]ProviderRuntimeSession),
		disconnectedSessions: make(map[string]bool),
		pendingInits:         make(map[string]bool),
	}
}

func (f *fakeRuntime) Cancel(_ context.Context, input RuntimeCancelInput) (RuntimeCancelResult, error) {
	f.cancelCalls = append(f.cancelCalls, input)
	targetAgentSessionID := input.RootAgentSessionID
	if len(input.Targets) > 0 {
		targetAgentSessionID = input.Targets[len(input.Targets)-1].AgentSessionID
	}
	if f.cancelErr != nil {
		return RuntimeCancelResult{AgentSessionID: targetAgentSessionID}, f.cancelErr
	}
	if f.cancelResultSet {
		if f.cancelResult.AgentSessionID == "" {
			f.cancelResult.AgentSessionID = targetAgentSessionID
		}
		return f.cancelResult, nil
	}
	return RuntimeCancelResult{
		AgentSessionID:   targetAgentSessionID,
		Canceled:         true,
		ConfirmedTargets: append([]RuntimeCancelTarget(nil), input.Targets...),
	}, nil
}

func (f *fakeRuntime) GoalControl(ctx context.Context, input RuntimeGoalControlInput) (RuntimeGoalControlResult, error) {
	f.mu.Lock()
	f.goalControlCalls = append(f.goalControlCalls, input)
	hook := f.goalControlHook
	f.mu.Unlock()
	if hook != nil {
		return hook(ctx, input)
	}
	goal := map[string]any(nil)
	if input.Action == "set" {
		goal = map[string]any{"objective": input.Objective, "status": "active"}
	}
	return RuntimeGoalControlResult{
		AgentSessionID: input.AgentSessionID, Goal: goal, ProviderPhase: "accepted",
		Evidence: map[string]any{"phase": "accepted"},
	}, nil
}

func (f *fakeRuntime) ReconcileGoal(ctx context.Context, input RuntimeGoalControlInput) (RuntimeGoalReconcileResult, error) {
	f.mu.Lock()
	f.goalReconcileCalls = append(f.goalReconcileCalls, input)
	hook := f.goalReconcileHook
	f.mu.Unlock()
	if hook != nil {
		return hook(ctx, input)
	}
	return RuntimeGoalReconcileResult{AgentSessionID: input.AgentSessionID,
		Evidence: map[string]any{"confidence": "unknown"}}, nil
}

func (f *fakeRuntime) GoalRecoveryPolicy(ctx context.Context, input RuntimeGoalControlInput) (RuntimeGoalRecoveryPolicy, error) {
	f.mu.Lock()
	hook := f.goalRecoveryPolicyHook
	f.mu.Unlock()
	if hook != nil {
		return hook(ctx, input)
	}
	return RuntimeGoalRecoveryPolicy{QuerySupported: true, ReplaySetAfterRestart: true}, nil
}

func (f *fakeRuntime) FenceGoalGeneration(ctx context.Context, input RuntimeGoalGenerationFenceInput) error {
	f.mu.Lock()
	f.goalGenerationFences = append(f.goalGenerationFences, input)
	hook := f.goalGenerationFenceHook
	f.mu.Unlock()
	if hook != nil {
		return hook(ctx, input)
	}
	return nil
}

func (f *fakeRuntime) Close(_ context.Context, input RuntimeCloseInput) error {
	f.closeCalls = append(f.closeCalls, input)
	err := f.closeErr
	if err == nil {
		key := input.WorkspaceID + ":" + input.AgentSessionID
		delete(f.sessions, key)
		delete(f.pendingInits, key)
	}
	// Hooks observe completion, so publish them only after the fake's state is
	// fully updated. Tests use this callback as the synchronization boundary.
	if f.closeHook != nil {
		f.closeHook(input)
	}
	return err
}

func (f *fakeRuntime) DisconnectRuntimeSession(
	_ context.Context,
	workspaceID string,
	agentSessionID string,
) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	key := strings.TrimSpace(workspaceID) + ":" + strings.TrimSpace(agentSessionID)
	if _, ok := f.sessions[key]; !ok || f.disconnectedSessions[key] {
		return false, nil
	}
	f.disconnectedSessions[key] = true
	return true, nil
}

func (f *fakeRuntime) CanResume(input RuntimeResumeInput) bool {
	f.canResumeCalls = append(f.canResumeCalls, input)
	if f.canResumeHook != nil {
		return f.canResumeHook(input)
	}
	return strings.TrimSpace(input.Provider) != ""
}

func (f *fakeRuntime) Exec(_ context.Context, input RuntimeExecInput) (RuntimeExecResult, error) {
	f.mu.Lock()
	key := input.WorkspaceID + ":" + input.AgentSessionID
	if f.disconnectedSessions[key] {
		f.resumeCalls = append(f.resumeCalls, RuntimeResumeInput{
			WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
		})
		delete(f.disconnectedSessions, key)
	}
	f.mu.Unlock()
	f.execCalls = append(f.execCalls, input)
	if input.Guidance && f.guidanceTargetMismatch && strings.TrimSpace(input.TurnID) != strings.TrimSpace(f.guidanceTarget) {
		return RuntimeExecResult{
			AgentSessionID: input.AgentSessionID,
			TurnID:         input.TurnID,
			ProviderDispatch: agenthost.RuntimeProviderDispatchResult{
				Disposition: agenthost.RuntimeDispatchDispositionNotDispatched,
			},
		}, ErrActiveTurnTargetMismatch
	}
	if input.Guidance {
		f.guidanceProviderCalls++
	}
	if f.execHook != nil {
		return f.execHook(input)
	}
	if f.execErr != nil {
		return RuntimeExecResult{}, f.execErr
	}
	if session, ok := f.sessions[key]; ok {
		session.Status = "working"
		session.Resumable = true
		if strings.TrimSpace(input.InitialTitle) != "" &&
			!session.InitialTitleEstablished {
			session.Title = strings.TrimSpace(input.InitialTitle)
			session.InitialTitleEstablished = true
		}
		session.UpdatedAtUnixMS = time.Now().UnixMilli()
		f.sessions[key] = session
	}
	turnID := strings.TrimSpace(input.TurnID)
	if turnID == "" {
		turnID = "turn-1"
	}
	return RuntimeExecResult{
		AgentSessionID: input.AgentSessionID,
		Status:         "started",
		Accepted:       true,
		SessionStatus:  "working",
		TurnID:         turnID,
		TurnLifecycle:  TurnLifecycle{Phase: "submitted"},
	}, nil
}

func (f *fakeRuntime) DurablyReportSubmitProvenance(_ context.Context, input RuntimeSubmitProvenanceInput) error {
	f.provenanceCalls = append(f.provenanceCalls, input)
	if f.provenanceHook != nil {
		return f.provenanceHook(input)
	}
	return f.provenanceErr
}

func (f *fakeRuntime) ValidatePromptContent(_ context.Context, input RuntimeExecInput) error {
	f.validateCalls = append(f.validateCalls, input)
	return f.validateErr
}

func (f *fakeRuntime) SubmitInteractive(_ context.Context, input RuntimeSubmitInteractiveInput) (RuntimeSubmitInteractiveResult, error) {
	f.submitInteractiveCalls = append(f.submitInteractiveCalls, input)
	disposition := f.interactiveDisposition
	if disposition == "" && f.submitInteractiveErr == nil {
		disposition = RuntimeInteractiveDispositionAnswered
	}
	if f.submitInteractiveErr != nil {
		return RuntimeSubmitInteractiveResult{Disposition: disposition}, f.submitInteractiveErr
	}
	return RuntimeSubmitInteractiveResult{Disposition: disposition}, nil
}

func (f *fakeRuntime) InteractiveDisposition(string, string, string, string, string) RuntimeInteractiveDisposition {
	if f.interactiveDisposition == "" {
		return RuntimeInteractiveDispositionUnknown
	}
	return f.interactiveDisposition
}

func (f *fakeRuntime) UpdateSettings(_ context.Context, input RuntimeUpdateSettingsInput) error {
	f.updateSettingsCalls = append(f.updateSettingsCalls, input)
	key := input.WorkspaceID + ":" + input.AgentSessionID
	session, ok := f.sessions[key]
	if !ok {
		return ErrSessionNotFound
	}
	settings := ComposerSettings{}
	if session.Settings != nil {
		settings = *session.Settings
	}
	if input.Settings.Model != nil {
		settings.Model = strings.TrimSpace(*input.Settings.Model)
	}
	if input.Settings.PermissionModeID != nil {
		settings.PermissionModeID = strings.TrimSpace(*input.Settings.PermissionModeID)
	}
	if input.Settings.PlanMode != nil {
		settings.PlanMode = *input.Settings.PlanMode
	}
	if input.Settings.ReasoningEffort != nil {
		settings.ReasoningEffort = strings.TrimSpace(*input.Settings.ReasoningEffort)
	}
	session.Settings = &settings
	session.UpdatedAtUnixMS = time.Now().UnixMilli()
	f.sessions[key] = session
	return nil
}

func (f *fakeRuntime) Resume(_ context.Context, input RuntimeResumeInput) (ProviderRuntimeSession, error) {
	f.resumeCalls = append(f.resumeCalls, input)
	if f.resumeErr != nil {
		return ProviderRuntimeSession{}, f.resumeErr
	}
	session := ProviderRuntimeSession{
		ID:                input.AgentSessionID,
		AgentTargetID:     input.AgentTargetID,
		Provider:          input.Provider,
		ProviderSessionID: input.ProviderSessionID,
		Resumable:         input.Resumable,
		Cwd:               input.Cwd,
		Env:               append([]string(nil), input.Env...),
		Settings:          cloneComposerSettingsPointer(&input.Settings),
		Status:            input.Status,
		Title:             input.Title,
		InitialTitleEstablished: initialTitleEstablishedForFakeRuntime(
			input.RuntimeContext,
			input.Title,
		),
		WorkspaceID:     input.WorkspaceID,
		CreatedAtUnixMS: input.CreatedAtUnixMS,
		UpdatedAtUnixMS: input.UpdatedAtUnixMS,
	}
	f.sessions[input.WorkspaceID+":"+input.AgentSessionID] = session
	delete(f.disconnectedSessions, input.WorkspaceID+":"+input.AgentSessionID)
	return session, nil
}

func (f *fakeRuntime) Session(workspaceID string, agentSessionID string) (ProviderRuntimeSession, bool) {
	key := workspaceID + ":" + agentSessionID
	session, ok := f.sessions[key]
	return session, ok
}

func (f *fakeRuntime) RuntimeSessionLive(workspaceID, agentSessionID string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	key := workspaceID + ":" + agentSessionID
	_, registered := f.sessions[key]
	return registered && !f.disconnectedSessions[key]
}

func (f *fakeRuntime) SetVisible(_ context.Context, input RuntimeSetVisibleInput) (ProviderRuntimeSession, error) {
	key := input.WorkspaceID + ":" + input.AgentSessionID
	session, ok := f.sessions[key]
	if !ok {
		return ProviderRuntimeSession{}, ErrSessionNotFound
	}
	session.Visible = input.Visible
	session.UpdatedAtUnixMS = time.Now().UnixMilli()
	f.sessions[key] = session
	return session, nil
}

func (f *fakeRuntime) SetTitle(_ context.Context, input RuntimeSetTitleInput) (ProviderRuntimeSession, error) {
	key := input.WorkspaceID + ":" + input.AgentSessionID
	session, ok := f.sessions[key]
	if !ok {
		return ProviderRuntimeSession{}, ErrSessionNotFound
	}
	session.Title = strings.TrimSpace(input.Title)
	session.UpdatedAtUnixMS = time.Now().UnixMilli()
	f.sessions[key] = session
	return session, nil
}

func (f *fakeRuntime) Sessions(workspaceID string) []ProviderRuntimeSession {
	result := make([]ProviderRuntimeSession, 0)
	for _, session := range f.sessions {
		if session.WorkspaceID == workspaceID {
			result = append(result, session)
		}
	}
	return result
}

func (f fakeSessionReader) GetSession(workspaceID string, agentSessionID string) (PersistedSession, bool) {
	key := workspaceID + ":" + agentSessionID
	session, ok := f.sessions[key]
	if !ok && f.runtime != nil {
		if runtimeSession, found := f.runtime.Session(workspaceID, agentSessionID); found {
			session = persistedSessionFromTestRuntime(runtimeSession)
			if canonicalReader, supported := f.runtime.(interface {
				GetSession(context.Context, string, string) (agentactivitybiz.Session, bool, error)
			}); supported {
				canonicalSession, canonicalFound, err := canonicalReader.GetSession(context.Background(), workspaceID, agentSessionID)
				if err == nil && canonicalFound {
					session.Kind = canonicalSession.Kind
					session.RootAgentSessionID = canonicalSession.RootAgentSessionID
				}
			}
			f.sessions[key] = session
			ok = true
		}
	}
	if ok && strings.TrimSpace(session.RailSectionKey) == "" {
		session.RailSectionKey = "conversations"
	}
	return session, ok
}

func persistedSessionFromTestRuntime(session ProviderRuntimeSession) PersistedSession {
	settings := ComposerSettings{}
	if session.Settings != nil {
		settings = *session.Settings
	}
	return PersistedSession{
		ID: session.ID, WorkspaceID: session.WorkspaceID, Kind: agentactivitybiz.SessionKindRoot,
		Provider: session.Provider, ProviderSessionID: session.ProviderSessionID,
		AgentTargetID: session.AgentTargetID, Cwd: session.Cwd, RailSectionKey: "conversations",
		Title: session.Title, Settings: settings, CreatedAtUnixMS: session.CreatedAtUnixMS,
		UpdatedAtUnixMS: session.UpdatedAtUnixMS, LastEventUnixMS: session.UpdatedAtUnixMS,
	}
}

func (f fakeSessionReader) SessionDeleted(_ context.Context, workspaceID string, agentSessionID string) (bool, error) {
	return f.tombstoned[workspaceID+":"+agentSessionID], nil
}

func (f fakeSessionReader) AgentSessionIDExists(_ context.Context, agentSessionID string) (bool, error) {
	agentSessionID = strings.TrimSpace(agentSessionID)
	if agentSessionID == "" {
		return false, nil
	}
	for _, session := range f.sessions {
		if strings.TrimSpace(session.ID) == agentSessionID {
			return true, nil
		}
	}
	keySuffix := ":" + agentSessionID
	for key, deleted := range f.tombstoned {
		if deleted && strings.HasSuffix(key, keySuffix) {
			return true, nil
		}
	}
	return false, nil
}

func (f fakeSessionReader) OtherWorkspaceLiveAgentSessionIDExists(
	_ context.Context,
	workspaceID string,
	agentSessionID string,
) (bool, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	for key, session := range f.sessions {
		if strings.TrimSpace(session.WorkspaceID) != workspaceID &&
			strings.TrimSpace(session.ID) == agentSessionID &&
			!f.tombstoned[key] {
			return true, nil
		}
	}
	return false, nil
}

func (f fakeSessionReader) ListSessions(workspaceID string) ([]PersistedSession, bool) {
	result := make([]PersistedSession, 0)
	for _, session := range f.sessions {
		if session.WorkspaceID == workspaceID {
			if strings.TrimSpace(session.RailSectionKey) == "" {
				session.RailSectionKey = "conversations"
			}
			result = append(result, session)
		}
	}
	return result, len(result) > 0
}

func (f fakeSessionReader) ListRecoverableDeletedSessionResources(
	context.Context,
) ([]agentactivitybiz.DeletedSessionResource, error) {
	return append([]agentactivitybiz.DeletedSessionResource(nil), f.recoverableDeleted...), nil
}

func (f fakeSessionReader) ListSessionsPage(
	_ context.Context,
	input agentactivitybiz.ListSessionsPageInput,
) (PersistedSessionListPage, bool, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	if workspaceID == "" {
		return PersistedSessionListPage{}, false, nil
	}
	targetID := strings.TrimSpace(input.AgentTargetID)
	searchTokens := strings.Fields(strings.ToLower(input.SearchQuery))
	sessions := make([]PersistedSession, 0, len(f.sessions))
	for key, session := range f.sessions {
		if strings.TrimSpace(session.WorkspaceID) != workspaceID || f.tombstoned[key] {
			continue
		}
		if kind := strings.TrimSpace(session.Kind); kind != "" && kind != agentactivitybiz.SessionKindRoot {
			continue
		}
		if !session.Metadata.Visible || (targetID != "" && strings.TrimSpace(session.AgentTargetID) != targetID) {
			continue
		}
		title := strings.ToLower(strings.TrimSpace(session.Title))
		matches := true
		for _, token := range searchTokens {
			if !strings.Contains(title, token) {
				matches = false
				break
			}
		}
		if matches {
			if strings.TrimSpace(session.RailSectionKey) == "" {
				session.RailSectionKey = "conversations"
			}
			sessions = append(sessions, session)
		}
	}
	sort.SliceStable(sessions, func(left, right int) bool {
		leftSortTime := fakePersistedSessionConversationSortTime(sessions[left])
		rightSortTime := fakePersistedSessionConversationSortTime(sessions[right])
		if leftSortTime == rightSortTime {
			return strings.TrimSpace(sessions[left].ID) < strings.TrimSpace(sessions[right].ID)
		}
		return leftSortTime > rightSortTime
	})
	if cursorID := strings.TrimSpace(input.CursorSessionID); cursorID != "" {
		start := len(sessions)
		for index, session := range sessions {
			sortTime := fakePersistedSessionConversationSortTime(session)
			if sortTime < input.CursorSortTimeUnixMS ||
				(sortTime == input.CursorSortTimeUnixMS && strings.TrimSpace(session.ID) > cursorID) {
				start = index
				break
			}
		}
		sessions = sessions[start:]
	}
	hasMore := input.Limit > 0 && len(sessions) > input.Limit
	if hasMore {
		sessions = sessions[:input.Limit]
	}
	nextCursor := ""
	if hasMore && len(sessions) > 0 {
		last := sessions[len(sessions)-1]
		nextCursor = strconv.FormatInt(fakePersistedSessionConversationSortTime(last), 10) + "|" + strings.TrimSpace(last.ID)
	}
	return PersistedSessionListPage{Sessions: sessions, HasMore: hasMore, NextCursor: nextCursor}, true, nil
}

func fakePersistedSessionConversationSortTime(session PersistedSession) int64 {
	if session.StartedAtUnixMS > 0 {
		return session.StartedAtUnixMS
	}
	return session.CreatedAtUnixMS
}

func (f fakeSessionReader) ListChildSessions(_ context.Context, workspaceID string, rootAgentSessionID string) ([]PersistedSession, error) {
	return append([]PersistedSession(nil), f.children[workspaceID+":"+rootAgentSessionID]...), nil
}

func (f *fakeSessionReader) UpdateSessionTitle(_ context.Context, workspaceID string, agentSessionID string, title string) (PersistedSession, bool, error) {
	key := workspaceID + ":" + agentSessionID
	session, ok := f.sessions[key]
	if !ok {
		return PersistedSession{}, false, nil
	}
	session.Title = strings.TrimSpace(title)
	session.UpdatedAtUnixMS = time.Now().UnixMilli()
	f.sessions[key] = session
	return session, true, nil
}

func (f *fakeSessionReader) UpdateSessionSettings(_ context.Context, workspaceID string, agentSessionID string, settings ComposerSettings) (PersistedSession, bool, error) {
	key := workspaceID + ":" + agentSessionID
	session, ok := f.sessions[key]
	if !ok {
		return PersistedSession{}, false, nil
	}
	session.Settings = settings
	session.UpdatedAtUnixMS = time.Now().UnixMilli()
	f.sessions[key] = session
	return session, true, nil
}

func (f *fakeSessionReader) UpdateSessionPinned(_ context.Context, workspaceID string, agentSessionID string, pinned bool) (PersistedSession, bool, error) {
	key := workspaceID + ":" + agentSessionID
	session, ok := f.sessions[key]
	if !ok {
		return PersistedSession{}, false, nil
	}
	session.PinnedAtUnixMS = 0
	if pinned {
		session.PinnedAtUnixMS = time.Now().UnixMilli()
	}
	session.UpdatedAtUnixMS = time.Now().UnixMilli()
	f.sessions[key] = session
	return session, true, nil
}

func (f fakeSessionReader) PlanDeleteSessions(_ context.Context, input agentactivitybiz.DeleteSessionsBatchInput) (agentactivitybiz.DeleteSessionsPlan, error) {
	ids := make([]string, 0, len(input.SessionIDs))
	for _, sessionID := range input.SessionIDs {
		if _, ok := f.sessions[input.WorkspaceID+":"+sessionID]; ok {
			ids = append(ids, sessionID)
		}
	}
	slices.Sort(ids)
	return agentactivitybiz.DeleteSessionsPlan{WorkspaceID: input.WorkspaceID, SessionIDs: ids}, nil
}

func (f fakeSessionReader) PlanClearSessions(_ context.Context, workspaceID string) (agentactivitybiz.DeleteSessionsPlan, error) {
	ids := make([]string, 0)
	for _, session := range f.sessions {
		if session.WorkspaceID == workspaceID {
			ids = append(ids, session.ID)
		}
	}
	slices.Sort(ids)
	return agentactivitybiz.DeleteSessionsPlan{WorkspaceID: workspaceID, SessionIDs: ids}, nil
}

func (f fakeSessionReader) DeleteSessionsBatch(_ context.Context, input agentactivitybiz.DeleteSessionsBatchInput) (agentactivitybiz.DeleteSessionsBatchResult, error) {
	removed := make([]string, 0, len(input.ExpectedSessionIDs))
	for _, sessionID := range input.ExpectedSessionIDs {
		key := input.WorkspaceID + ":" + sessionID
		if _, ok := f.sessions[key]; !ok {
			continue
		}
		delete(f.sessions, key)
		removed = append(removed, sessionID)
	}
	return agentactivitybiz.DeleteSessionsBatchResult{RemovedSessions: len(removed), RemovedSessionIDs: removed}, nil
}

func (f fakeSessionReader) PurgeDeletedSessions(_ context.Context, input agentactivitybiz.PurgeDeletedSessionsInput) (agentactivitybiz.PurgeDeletedSessionsResult, error) {
	if input.CutoffUnixMS <= 0 {
		return agentactivitybiz.PurgeDeletedSessionsResult{}, nil
	}
	limit := input.MaxSessions
	if limit <= 0 {
		limit = 25
	}
	if limit > 100 {
		limit = 100
	}
	type treeMember struct {
		key             string
		depth           int
		deletedAtUnixMS int64
	}
	type purgeTree struct {
		workspaceID     string
		rootSessionID   string
		deletedAtUnixMS int64
		members         []treeMember
	}
	effectiveDeletedAt := func(key string) int64 {
		deletedAt := f.deletedAt[key]
		if deletedAt <= 0 {
			return 1
		}
		return deletedAt
	}
	childrenByParent := make(map[string][]string)
	for childKey, parentKey := range f.parentByKey {
		if _, exists := f.sessions[childKey]; !exists {
			continue
		}
		childrenByParent[parentKey] = append(childrenByParent[parentKey], childKey)
	}
	for parentKey := range childrenByParent {
		slices.Sort(childrenByParent[parentKey])
	}

	rootKeys := make([]string, 0)
	for key, deleted := range f.tombstoned {
		if !deleted || effectiveDeletedAt(key) > input.CutoffUnixMS {
			continue
		}
		if _, exists := f.sessions[key]; !exists {
			continue
		}
		parentKey := f.parentByKey[key]
		if parentKey != "" && f.tombstoned[parentKey] {
			continue
		}
		rootKeys = append(rootKeys, key)
	}
	slices.Sort(rootKeys)

	trees := make([]purgeTree, 0, len(rootKeys))
	for _, rootKey := range rootKeys {
		rootSession := f.sessions[rootKey]
		tree := purgeTree{
			workspaceID: rootSession.WorkspaceID, rootSessionID: rootSession.ID,
			deletedAtUnixMS: effectiveDeletedAt(rootKey),
		}
		pending := []treeMember{{key: rootKey}}
		complete := true
		visited := make(map[string]struct{})
		for len(pending) > 0 {
			member := pending[0]
			pending = pending[1:]
			if _, duplicate := visited[member.key]; duplicate {
				complete = false
				break
			}
			visited[member.key] = struct{}{}
			if !f.tombstoned[member.key] || effectiveDeletedAt(member.key) > input.CutoffUnixMS {
				complete = false
				break
			}
			member.deletedAtUnixMS = effectiveDeletedAt(member.key)
			tree.members = append(tree.members, member)
			for _, childKey := range childrenByParent[member.key] {
				pending = append(pending, treeMember{key: childKey, depth: member.depth + 1})
			}
		}
		if !complete {
			continue
		}
		sort.Slice(tree.members, func(i, j int) bool {
			if tree.members[i].depth != tree.members[j].depth {
				return tree.members[i].depth > tree.members[j].depth
			}
			return f.sessions[tree.members[i].key].ID < f.sessions[tree.members[j].key].ID
		})
		trees = append(trees, tree)
	}
	sort.Slice(trees, func(i, j int) bool {
		if trees[i].deletedAtUnixMS != trees[j].deletedAtUnixMS {
			return trees[i].deletedAtUnixMS < trees[j].deletedAtUnixMS
		}
		if trees[i].workspaceID != trees[j].workspaceID {
			return trees[i].workspaceID < trees[j].workspaceID
		}
		return trees[i].rootSessionID < trees[j].rootSessionID
	})

	selected := make([]purgeTree, 0, len(trees))
	selectedSessionCount := 0
	for _, tree := range trees {
		if len(selected) > 0 && selectedSessionCount+len(tree.members) > limit {
			break
		}
		selected = append(selected, tree)
		selectedSessionCount += len(tree.members)
	}
	result := agentactivitybiz.PurgeDeletedSessionsResult{HasMore: len(selected) < len(trees)}
	for _, tree := range selected {
		for _, member := range tree.members {
			session := f.sessions[member.key]
			delete(f.sessions, member.key)
			delete(f.tombstoned, member.key)
			delete(f.deletedAt, member.key)
			delete(f.parentByKey, member.key)
			result.Sessions = append(result.Sessions, agentactivitybiz.PurgedSession{
				WorkspaceID: session.WorkspaceID, AgentSessionID: session.ID,
				DeletedAtUnixMS: member.deletedAtUnixMS,
			})
		}
	}
	return result, nil
}

func (f *fakeRuntime) Start(_ context.Context, input RuntimeStartInput) (RuntimeStartResult, error) {
	f.startCalls = append(f.startCalls, input)
	if f.startErr != nil {
		return RuntimeStartResult{}, f.startErr
	}
	f.nextID++
	now := time.Now().UnixMilli()
	id := strings.TrimSpace(input.AgentSessionID)
	if id == "" {
		id = "session-" + string(rune('0'+f.nextID))
	}
	if existing, ok := f.sessions[input.WorkspaceID+":"+id]; ok {
		return RuntimeStartResult{Session: existing, Created: false}, nil
	}
	session := ProviderRuntimeSession{
		ID:            id,
		AgentTargetID: input.AgentTargetID,
		Provider:      input.Provider,
		Cwd:           input.Cwd,
		Settings: &ComposerSettings{
			Model:                  input.Model,
			PermissionModeID:       input.PermissionModeID,
			PlanMode:               input.PlanMode,
			ReasoningEffort:        input.ReasoningEffort,
			ConversationDetailMode: input.ConversationDetailMode,
		},
		Status: "ready",
		Title:  input.Title,
		InitialTitleEstablished: input.InitialTitleEstablished ||
			titletext.Normalize(input.Title) != "",
		Visible:         input.Visible == nil || *input.Visible,
		RuntimeContext:  clonePayload(input.RuntimeContext),
		WorkspaceID:     input.WorkspaceID,
		CreatedAtUnixMS: now,
		UpdatedAtUnixMS: now,
	}
	if f.startHook != nil {
		session = f.startHook(input, session)
	}
	f.sessions[input.WorkspaceID+":"+session.ID] = session
	if input.CanonicalInitPending {
		if f.pendingInits == nil {
			f.pendingInits = make(map[string]bool)
		}
		f.pendingInits[input.WorkspaceID+":"+session.ID] = true
	}
	return RuntimeStartResult{Session: session, Created: true}, nil
}

func (f *fakeRuntime) PublishSessionInitialization(
	_ context.Context,
	input RuntimeSessionInitializationPublishInput,
) (ProviderRuntimeSession, error) {
	f.publishInitCalls = append(f.publishInitCalls, input)
	key := input.WorkspaceID + ":" + input.AgentSessionID
	session, found := f.sessions[key]
	if !found {
		return ProviderRuntimeSession{}, ErrSessionNotFound
	}
	if f.publishInitHook != nil {
		if err := f.publishInitHook(input, session); err != nil {
			return ProviderRuntimeSession{}, err
		}
	}
	delete(f.pendingInits, key)
	return session, nil
}

func initialTitleEstablishedForFakeRuntime(
	runtimeContext map[string]any,
	title string,
) bool {
	if strings.TrimSpace(title) != "" {
		return true
	}
	if established, ok := runtimeContext["tuttiInitialTitleEstablished"].(bool); ok {
		return established
	}
	return true
}

func (*fakeRuntime) Subscribe(string, string) (<-chan RuntimeStreamEvent, func(), bool) {
	events := make(chan RuntimeStreamEvent)
	close(events)
	return events, func() {}, true
}
