// Package conformance provides lifecycle scenarios shared by the legacy
// tuttid Service, the Agent Host implementation, and downstream host adapters.
package conformance

import (
	"context"
	"errors"
	"fmt"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

type SessionSeed struct {
	WorkspaceID             string
	AgentSessionID          string
	Provider                string
	ProviderSessionID       string
	Cwd                     string
	Title                   string
	ActiveTurnID            string
	InitialTitleEstablished bool
	Live                    bool
	Kind                    string
	Origin                  string
	Deleted                 bool
	ExternalResumeSupported *bool
	Settings                agenthost.ComposerSettings
	Pinned                  bool
}

type TurnSeed struct {
	TurnID  string
	Phase   string
	Outcome string
}

type InteractionSeed struct {
	RequestID string
	TurnID    string
	Kind      string
	Status    string
}

type Fixture struct {
	Session            *SessionSeed
	Turn               *TurnSeed
	Interaction        *InteractionSeed
	PreparedSubmitID   string
	RecoverInteractive bool
	DisableGoalInbox   bool
	FailCommitObserver bool
	WorktreeGCSweepErr error
}

type SessionObservation struct {
	SessionID         string
	ProviderSessionID string
	Title             string
	ActiveTurnID      string
	Resumable         bool
	Settings          agenthost.ComposerSettings
	Pinned            bool
	Live              bool
}

type SendObservation struct {
	Session  SessionObservation
	TurnID   string
	Kind     string
	Goal     map[string]any
	Revision int64
}

type GoalObservation struct {
	Goal               map[string]any
	Revision           int64
	PendingOperationID string
	SyncStatus         string
}

type CancelObservation struct {
	Session  SessionObservation
	TurnID   string
	Canceled bool
	Reason   string
}

type OperationObservation struct {
	OperationID string
	Status      string
	Result      string
}

type Metrics struct {
	StartCalls               int
	ResumeCalls              int
	ExecCalls                int
	CancelCalls              int
	InteractiveCalls         int
	UpdateSettingsCalls      int
	CloseCalls               int
	GoalControlCalls         int
	GoalReconcileCalls       int
	RuntimeOperationCommits  int
	GoalOperationCommits     int
	RootTurnSettlements      int
	LastCancelTargets        []agenthost.RuntimeCancelTarget
	LastInteractiveTurnID    string
	LastInteractiveRequestID string
	LastInitialTitle         string
	LastResumeRecreate       bool
	RecoverySteps            []string
}

// Driver adapts one host implementation to the shared lifecycle scenarios.
// Reset is test-only canonical/runtime seeding; command methods mirror the
// provider-neutral Host application surface rather than any transport API.
type Driver interface {
	Reset(context.Context, Fixture) error
	Create(context.Context, string, agenthost.CreateSessionInput) (SessionObservation, string, error)
	EnsureSession(context.Context, agenthost.SessionRef) (SessionObservation, error)
	SendInput(context.Context, agenthost.SessionRef, agenthost.SendInput) (SendObservation, error)
	CancelTurn(context.Context, agenthost.CancelTurnInput) (CancelObservation, error)
	SubmitInteractive(context.Context, agenthost.SessionRef, string, agenthost.SubmitInteractiveInput) (SessionObservation, error)
	SubmitPlanDecision(context.Context, agenthost.SessionRef, string, string, agenthost.SubmitPlanDecisionInput) (OperationObservation, error)
	UpdateTitle(context.Context, agenthost.UpdateTitleInput) (SessionObservation, error)
	GetSession(context.Context, agenthost.SessionRef) (SessionObservation, error)
	UpdateSettings(context.Context, agenthost.UpdateSettingsInput) (SessionObservation, error)
	UpdatePin(context.Context, agenthost.UpdatePinInput) (SessionObservation, error)
	DeleteSession(context.Context, agenthost.SessionRef) (agenthost.DeleteSessionResult, error)
	GoalControl(context.Context, agenthost.GoalControlInput) (GoalObservation, error)
	GetGoalState(context.Context, agenthost.SessionRef) (GoalObservation, error)
	ReconcileGoal(context.Context, agenthost.SessionRef) (GoalObservation, error)
	Recover(context.Context) error
	Metrics() Metrics
}

type Scenario struct {
	Name string
	run  func(context.Context, Driver) error
}

func Scenarios() []Scenario {
	return []Scenario{
		{Name: "create empty session", run: runCreateEmptySession},
		{Name: "create with initial content", run: runCreateWithInitialContent},
		{Name: "resume persisted session", run: runResumePersistedSession},
		{Name: "send input", run: runSendInput},
		{Name: "duplicate client submit id", run: runDuplicateClientSubmitID},
		{Name: "exact turn cancel", run: runExactTurnCancel},
		{Name: "interactive response", run: runInteractiveResponse},
		{Name: "plan decision", run: runPlanDecision},
		{Name: "initial title cas", run: runInitialTitleCAS},
		{Name: "get session", run: runGetSession},
		{Name: "historical and live settings", run: runHistoricalAndLiveSettings},
		{Name: "pin session", run: runPinSession},
		{Name: "delete session", run: runDeleteSession},
	}
}

func ResumePolicyScenarios() []Scenario {
	return []Scenario{
		{Name: "resume imported session by recreate policy", run: runResumeImportedSession},
		{Name: "reject imported session without resume support", run: runRejectUnsupportedImport},
		{Name: "reject child independent resume", run: runRejectChildResume},
		{Name: "reject tombstoned resume", run: runRejectTombstonedResume},
	}
}

func SubmissionFenceScenarios() []Scenario {
	return []Scenario{{Name: "prepared submit claim does not replay provider", run: runPreparedSubmitClaim}}
}

func TitlePolicyScenarios() []Scenario {
	return []Scenario{{Name: "clear canonical title", run: runClearCanonicalTitle}}
}

func CoordinatorScenarios() []Scenario {
	result := make([]Scenario, 0, 5)
	for _, scenario := range Scenarios() {
		switch scenario.Name {
		case "exact turn cancel", "interactive response", "plan decision":
			result = append(result, scenario)
		}
	}
	return append(result,
		Scenario{Name: "recover operations before stale turns and worktree sweep", run: runRecoveryOrder},
		Scenario{Name: "worktree sweep failure propagates", run: runWorktreeSweepFailure},
	)
}

func GoalScenarios() []Scenario {
	return []Scenario{
		{Name: "direct and typed goal equivalence", run: runDirectAndTypedGoalEquivalence},
		{Name: "goal action lifecycle", run: runGoalActionLifecycle},
		{Name: "goal reconcile observation", run: runGoalReconcileObservation},
		{Name: "goal revision actor fence", run: runGoalRevisionActorFence},
		{Name: "goal inbox consumer preflight", run: runGoalInboxConsumerPreflight},
	}
}

// CommitObserverScenarios verify the typed post-commit seam independently of
// any adapter-specific event transport. They intentionally include a failing
// observer because observer delivery is advisory after the durable commit.
func CommitObserverScenarios() []Scenario {
	return []Scenario{
		{Name: "runtime commit observer failure is post-commit", run: runRuntimeCommitObserverFailure},
		{Name: "goal operation emits committed deltas", run: runGoalOperationCommittedDeltas},
	}
}

// ApplicationCoreScenarios are the create/resume/send/title scenarios owned by
// the PR2 Host slice. The remaining scenarios stay in Scenarios and move to
// direct Host execution with their coordinators in the following extraction.
func ApplicationCoreScenarios() []Scenario {
	result := make([]Scenario, 0)
	for _, scenario := range Scenarios() {
		switch scenario.Name {
		case "exact turn cancel", "interactive response", "plan decision":
			continue
		default:
			result = append(result, scenario)
		}
	}
	return result
}

func Run(ctx context.Context, driver Driver, scenario Scenario) error {
	if driver == nil {
		return fmt.Errorf("agent host conformance driver is required")
	}
	if scenario.run == nil {
		return fmt.Errorf("agent host conformance scenario %q has no runner", scenario.Name)
	}
	return scenario.run(ctx, driver)
}

func runCreateEmptySession(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, Fixture{}); err != nil {
		return err
	}
	session, turnID, err := driver.Create(ctx, "workspace-1", agenthost.CreateSessionInput{
		AgentSessionID: "session-empty", AgentTargetID: "target-1", Provider: "codex",
	})
	if err != nil {
		return fmt.Errorf("create empty session: %w", err)
	}
	if session.SessionID != "session-empty" || turnID != "" {
		return fmt.Errorf("create empty session = %#v turn %q", session, turnID)
	}
	if session.Title != "" {
		return fmt.Errorf("empty create canonical title=%q", session.Title)
	}
	metrics := driver.Metrics()
	if metrics.StartCalls != 1 || metrics.ExecCalls != 0 {
		return fmt.Errorf("create empty calls start=%d exec=%d", metrics.StartCalls, metrics.ExecCalls)
	}
	return nil
}

func runCreateWithInitialContent(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, Fixture{}); err != nil {
		return err
	}
	input := agenthost.CreateSessionInput{
		AgentSessionID: "session-initial", AgentTargetID: "target-1", Provider: "codex",
		InitialContent: []agenthost.PromptContentBlock{{Type: "text", Text: "build the feature"}},
		Metadata:       map[string]any{"clientSubmitId": "caller-controlled"}, ClientSubmitID: "create-submit-1",
	}
	session, turnID, err := driver.Create(ctx, "workspace-1", input)
	if err != nil {
		return fmt.Errorf("create with initial content: %w", err)
	}
	if session.SessionID != "session-initial" || turnID == "" {
		return fmt.Errorf("create with initial content = %#v turn %q", session, turnID)
	}
	if err := verifyRetriedInitialCreate(ctx, driver, input, session, turnID); err != nil {
		return err
	}
	metrics := driver.Metrics()
	if metrics.StartCalls != 1 || metrics.ExecCalls != 1 {
		return fmt.Errorf("create with initial content calls start=%d exec=%d", metrics.StartCalls, metrics.ExecCalls)
	}
	return nil
}

func runResumePersistedSession(ctx context.Context, driver Driver) error {
	fixture := Fixture{Session: &SessionSeed{
		WorkspaceID: "workspace-1", AgentSessionID: "session-resume", Provider: "codex",
		ProviderSessionID: "provider-session-1", Cwd: "/workspace", Title: "Persisted", InitialTitleEstablished: true,
	}}
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	session, err := driver.EnsureSession(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-resume"})
	if err != nil {
		return fmt.Errorf("resume persisted session: %w", err)
	}
	if session.SessionID != "session-resume" || session.ProviderSessionID != "provider-session-1" || !session.Resumable {
		return fmt.Errorf("resumed session = %#v", session)
	}
	if metrics := driver.Metrics(); metrics.ResumeCalls != 1 || metrics.StartCalls != 0 {
		return fmt.Errorf("resume calls resume=%d start=%d", metrics.ResumeCalls, metrics.StartCalls)
	}
	return nil
}

func runResumeImportedSession(ctx context.Context, driver Driver) error {
	fixture := Fixture{Session: &SessionSeed{
		WorkspaceID: "workspace-1", AgentSessionID: "session-imported", Provider: "codex",
		ProviderSessionID: "imported-provider-session", Cwd: "/workspace", Origin: agenthost.WorkspaceAgentSessionOriginImported,
	}}
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	if _, err := driver.EnsureSession(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-imported"}); err != nil {
		return fmt.Errorf("resume imported session: %w", err)
	}
	metrics := driver.Metrics()
	if metrics.ResumeCalls != 1 || !metrics.LastResumeRecreate {
		return fmt.Errorf("imported resume metrics=%#v", metrics)
	}
	return nil
}

func runRejectUnsupportedImport(ctx context.Context, driver Driver) error {
	supported := false
	return runRejectedResume(ctx, driver, SessionSeed{
		WorkspaceID: "workspace-1", AgentSessionID: "session-export", Provider: "codex",
		ProviderSessionID: "web-export", Origin: agenthost.WorkspaceAgentSessionOriginImported,
		ExternalResumeSupported: &supported,
	})
}

func runRejectChildResume(ctx context.Context, driver Driver) error {
	return runRejectedResume(ctx, driver, SessionSeed{
		WorkspaceID: "workspace-1", AgentSessionID: "session-child", Provider: "codex",
		ProviderSessionID: "child-provider", Kind: canonical.SessionKindChild,
	})
}

func runRejectTombstonedResume(ctx context.Context, driver Driver) error {
	return runRejectedResume(ctx, driver, SessionSeed{
		WorkspaceID: "workspace-1", AgentSessionID: "session-deleted", Provider: "codex",
		ProviderSessionID: "deleted-provider", Deleted: true,
	})
}

func runRejectedResume(ctx context.Context, driver Driver, seed SessionSeed) error {
	if err := driver.Reset(ctx, Fixture{Session: &seed}); err != nil {
		return err
	}
	_, err := driver.EnsureSession(ctx, agenthost.SessionRef{WorkspaceID: seed.WorkspaceID, AgentSessionID: seed.AgentSessionID})
	if !errors.Is(err, agenthost.ErrSessionNotFound) {
		return fmt.Errorf("rejected resume error=%v", err)
	}
	if metrics := driver.Metrics(); metrics.ResumeCalls != 0 {
		return fmt.Errorf("rejected resume calls=%d", metrics.ResumeCalls)
	}
	return nil
}

func runSendInput(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, liveSessionFixture("session-send", "")); err != nil {
		return err
	}
	result, err := driver.SendInput(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-send"}, agenthost.SendInput{
		Content: []agenthost.PromptContentBlock{{Type: "text", Text: "continue"}},
	})
	if err != nil {
		return fmt.Errorf("send input: %w", err)
	}
	if result.Session.SessionID != "session-send" || result.TurnID == "" {
		return fmt.Errorf("send input result = %#v", result)
	}
	if metrics := driver.Metrics(); metrics.ExecCalls != 1 {
		return fmt.Errorf("send input exec calls=%d", metrics.ExecCalls)
	}
	return nil
}

func runDuplicateClientSubmitID(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, liveSessionFixture("session-duplicate", "")); err != nil {
		return err
	}
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-duplicate"}
	input := agenthost.SendInput{
		Content:        []agenthost.PromptContentBlock{{Type: "text", Text: "only once"}},
		Metadata:       map[string]any{"clientSubmitId": "caller-controlled"},
		ClientSubmitID: "submit-duplicate-1",
	}
	first, err := driver.SendInput(ctx, ref, input)
	if err != nil {
		return fmt.Errorf("first idempotent send: %w", err)
	}
	duplicateInput := input
	duplicateInput.Metadata = map[string]any{"clientSubmitId": "different-caller-controlled"}
	duplicate, err := driver.SendInput(ctx, ref, duplicateInput)
	if err != nil {
		return fmt.Errorf("duplicate idempotent send: %w", err)
	}
	if first.TurnID == "" || duplicate.TurnID != first.TurnID {
		return fmt.Errorf("duplicate turns first=%q duplicate=%q", first.TurnID, duplicate.TurnID)
	}
	if metrics := driver.Metrics(); metrics.ExecCalls != 1 {
		return fmt.Errorf("duplicate submit exec calls=%d", metrics.ExecCalls)
	}
	return nil
}

func runPreparedSubmitClaim(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-prepared", "")
	fixture.PreparedSubmitID = "submit-prepared-1"
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	_, err := driver.SendInput(ctx,
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-prepared"},
		agenthost.SendInput{
			Content:  []agenthost.PromptContentBlock{{Type: "text", Text: "do not replay"}},
			Metadata: map[string]any{"clientSubmitId": "submit-prepared-1"},
		},
	)
	if !errors.Is(err, agenthost.ErrSubmitDeliveryUnknown) {
		return fmt.Errorf("prepared submit error=%v", err)
	}
	if metrics := driver.Metrics(); metrics.ExecCalls != 0 {
		return fmt.Errorf("prepared submit exec calls=%d", metrics.ExecCalls)
	}
	return nil
}

func runExactTurnCancel(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-cancel", "turn-cancel")
	fixture.Turn = &TurnSeed{TurnID: "turn-cancel", Phase: canonical.TurnPhaseRunning}
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	result, err := driver.CancelTurn(ctx, agenthost.CancelTurnInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-cancel", TurnID: "turn-cancel", Reason: "user_requested",
	})
	if err != nil {
		return fmt.Errorf("exact turn cancel: %w", err)
	}
	metrics := driver.Metrics()
	if !result.Canceled || result.TurnID != "turn-cancel" || metrics.CancelCalls != 1 || len(metrics.LastCancelTargets) != 1 ||
		metrics.LastCancelTargets[0].AgentSessionID != "session-cancel" || metrics.LastCancelTargets[0].TurnID != "turn-cancel" {
		return fmt.Errorf("cancel result=%#v metrics=%#v", result, metrics)
	}
	return nil
}

func runInteractiveResponse(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-interactive", "turn-interactive")
	fixture.Turn = &TurnSeed{TurnID: "turn-interactive", Phase: canonical.TurnPhaseWaiting}
	fixture.Interaction = &InteractionSeed{
		RequestID: "request-1", TurnID: "turn-interactive", Kind: canonical.InteractionKindApproval, Status: canonical.InteractionStatusPending,
	}
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	optionID := "approve"
	if _, err := driver.SubmitInteractive(ctx,
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-interactive"},
		"request-1", agenthost.SubmitInteractiveInput{TurnID: "turn-interactive", OptionID: &optionID},
	); err != nil {
		return fmt.Errorf("submit interactive: %w", err)
	}
	metrics := driver.Metrics()
	if metrics.InteractiveCalls != 1 || metrics.LastInteractiveTurnID != "turn-interactive" || metrics.LastInteractiveRequestID != "request-1" {
		return fmt.Errorf("interactive metrics=%#v", metrics)
	}
	return nil
}

func runPlanDecision(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-plan", "plan-turn")
	fixture.Turn = &TurnSeed{TurnID: "plan-turn", Phase: canonical.TurnPhaseWaiting}
	fixture.Interaction = &InteractionSeed{
		RequestID: "plan-turn", TurnID: "plan-turn", Kind: canonical.InteractionKindPlan, Status: canonical.InteractionStatusPending,
	}
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	operation, err := driver.SubmitPlanDecision(ctx,
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-plan"},
		"plan-turn", "plan-turn", agenthost.SubmitPlanDecisionInput{
			PromptKind: "plan-implementation", Action: "implement", IdempotencyKey: "decision-1",
		},
	)
	if err != nil {
		return fmt.Errorf("submit plan decision: %w", err)
	}
	metrics := driver.Metrics()
	if operation.OperationID == "" || metrics.UpdateSettingsCalls != 1 || metrics.ExecCalls != 1 {
		return fmt.Errorf("plan operation=%#v metrics=%#v", operation, metrics)
	}
	return nil
}

func runInitialTitleCAS(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, Fixture{}); err != nil {
		return err
	}
	session, _, err := driver.Create(ctx, "workspace-1", agenthost.CreateSessionInput{
		AgentSessionID: "session-title", AgentTargetID: "target-1", Provider: "codex",
		InitialContent: []agenthost.PromptContentBlock{{Type: "text", Text: "Derived title"}},
	})
	if err != nil {
		return fmt.Errorf("create title session: %w", err)
	}
	if session.Title != "Derived title" {
		return fmt.Errorf("derived title=%q", session.Title)
	}
	session, err = driver.UpdateTitle(ctx, agenthost.UpdateTitleInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-title", Title: "Explicit title",
	})
	if err != nil {
		return fmt.Errorf("update explicit title: %w", err)
	}
	if session.Title != "Explicit title" {
		return fmt.Errorf("updated title=%q", session.Title)
	}
	result, err := driver.SendInput(ctx,
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-title"},
		agenthost.SendInput{Content: []agenthost.PromptContentBlock{{Type: "text", Text: "Must not replace title"}}},
	)
	if err != nil {
		return fmt.Errorf("send after explicit title: %w", err)
	}
	if result.Session.Title != "Explicit title" || driver.Metrics().LastInitialTitle != "" {
		return fmt.Errorf("title CAS result=%#v metrics=%#v", result, driver.Metrics())
	}
	return nil
}

func runClearCanonicalTitle(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, liveSessionFixture("session-clear-title", "")); err != nil {
		return err
	}
	session, err := driver.UpdateTitle(ctx, agenthost.UpdateTitleInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-clear-title", Title: "",
	})
	if err != nil {
		return fmt.Errorf("clear canonical title: %w", err)
	}
	if session.Title != "" {
		return fmt.Errorf("cleared title=%q", session.Title)
	}
	return nil
}

func runGetSession(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-get", "")
	fixture.Session.Title = "canonical title"
	fixture.Session.Settings = agenthost.ComposerSettings{Model: "model-a", PermissionModeID: "auto", Speed: "standard"}
	fixture.Session.Pinned = true
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	result, err := driver.GetSession(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-get"})
	if err != nil {
		return fmt.Errorf("get session: %w", err)
	}
	if result.SessionID != "session-get" || result.Title != "canonical title" || !result.Live || !result.Pinned ||
		result.Settings.Model != "model-a" || result.Settings.PermissionModeID != "auto" {
		return fmt.Errorf("get session=%#v", result)
	}
	return nil
}

func runHistoricalAndLiveSettings(ctx context.Context, driver Driver) error {
	historical := Fixture{Session: &SessionSeed{
		WorkspaceID: "workspace-1", AgentSessionID: "session-settings-history", Provider: "claude-code",
		ProviderSessionID: "provider-settings-history", Cwd: "/workspace",
		Settings: agenthost.ComposerSettings{Model: "model-a", PermissionModeID: "review"},
	}}
	if err := driver.Reset(ctx, historical); err != nil {
		return err
	}
	permissionMode := "acceptEdits"
	result, err := driver.UpdateSettings(ctx, agenthost.UpdateSettingsInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-settings-history",
		Settings: agenthost.ComposerSettingsPatch{PermissionModeID: &permissionMode},
	})
	if err != nil {
		return fmt.Errorf("update historical settings: %w", err)
	}
	if result.Live || result.Settings.Model != "model-a" || result.Settings.PermissionModeID != "acceptEdits" ||
		driver.Metrics().UpdateSettingsCalls != 0 || driver.Metrics().ResumeCalls != 0 {
		return fmt.Errorf("historical settings=%#v metrics=%#v", result, driver.Metrics())
	}

	live := liveSessionFixture("session-settings-live", "")
	live.Session.Settings = agenthost.ComposerSettings{Model: "model-a", PermissionModeID: "review"}
	if err := driver.Reset(ctx, live); err != nil {
		return err
	}
	planMode := true
	result, err = driver.UpdateSettings(ctx, agenthost.UpdateSettingsInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-settings-live",
		Settings: agenthost.ComposerSettingsPatch{PlanMode: &planMode},
	})
	if err != nil {
		return fmt.Errorf("update live settings: %w", err)
	}
	if !result.Live || !result.Settings.PlanMode || result.Settings.Model != "model-a" ||
		driver.Metrics().UpdateSettingsCalls != 1 {
		return fmt.Errorf("live settings=%#v metrics=%#v", result, driver.Metrics())
	}
	return nil
}

func runPinSession(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, Fixture{Session: &SessionSeed{
		WorkspaceID: "workspace-1", AgentSessionID: "session-pin", Provider: "codex", Cwd: "/workspace",
	}}); err != nil {
		return err
	}
	result, err := driver.UpdatePin(ctx, agenthost.UpdatePinInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-pin", Pinned: true,
	})
	if err != nil {
		return fmt.Errorf("pin session: %w", err)
	}
	if !result.Pinned {
		return fmt.Errorf("pinned session=%#v", result)
	}
	result, err = driver.UpdatePin(ctx, agenthost.UpdatePinInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-pin", Pinned: false,
	})
	if err != nil {
		return fmt.Errorf("unpin session: %w", err)
	}
	if result.Pinned {
		return fmt.Errorf("unpinned session=%#v", result)
	}
	return nil
}

func runDeleteSession(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, liveSessionFixture("session-delete", "")); err != nil {
		return err
	}
	result, err := driver.DeleteSession(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-delete"})
	if err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	if !result.Deleted || !result.RuntimeClosed || !result.CanonicalRemoved || driver.Metrics().CloseCalls != 1 {
		return fmt.Errorf("delete result=%#v metrics=%#v", result, driver.Metrics())
	}
	if _, err := driver.GetSession(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-delete"}); !errors.Is(err, agenthost.ErrSessionNotFound) {
		return fmt.Errorf("get deleted session error=%v", err)
	}
	return nil
}

func runRecoveryOrder(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-recovery", "turn-recovery")
	fixture.Turn = &TurnSeed{TurnID: "turn-recovery", Phase: canonical.TurnPhaseWaiting}
	fixture.Interaction = &InteractionSeed{
		RequestID: "request-recovery", TurnID: "turn-recovery",
		Kind: canonical.InteractionKindApproval, Status: canonical.InteractionStatusPending,
	}
	fixture.RecoverInteractive = true
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	if err := driver.Recover(ctx); err != nil {
		return fmt.Errorf("recover host: %w", err)
	}
	steps := driver.Metrics().RecoverySteps
	want := []string{"runtime_requeue", "runtime_complete", "goal_requeue", "goal_inbox_requeue", "stale_settle", "worktree_sweep"}
	if len(steps) != len(want) {
		return fmt.Errorf("recovery steps=%v, want %v", steps, want)
	}
	for index := range want {
		if steps[index] != want[index] {
			return fmt.Errorf("recovery steps=%v, want %v", steps, want)
		}
	}
	return nil
}

func runDirectAndTypedGoalEquivalence(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-goal-direct", "")
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	direct, err := driver.GoalControl(ctx, agenthost.GoalControlInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-goal-direct", Action: "set", Objective: "ship it",
		SubmissionMetadata: map[string]any{"clientSubmitId": "goal-direct"},
	})
	if err != nil {
		return fmt.Errorf("direct goal control: %w", err)
	}
	fixture = liveSessionFixture("session-goal-typed", "")
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	typed, err := driver.SendInput(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-goal-typed"}, agenthost.SendInput{
		Content:  []agenthost.PromptContentBlock{{Type: "text", Text: "/goal ship it"}},
		Metadata: map[string]any{"clientSubmitId": "goal-typed"},
	})
	if err != nil {
		return fmt.Errorf("typed goal control: %w", err)
	}
	if typed.Kind != "goalControl" || typed.TurnID != "" || driver.Metrics().ExecCalls != 0 {
		return fmt.Errorf("typed goal opened a turn: result=%#v metrics=%#v", typed, driver.Metrics())
	}
	if metadataString(direct.Goal, "objective") != "ship it" || metadataString(typed.Goal, "objective") != "ship it" || direct.Revision != typed.Revision {
		return fmt.Errorf("direct=%#v typed=%#v", direct, typed)
	}
	return nil
}

func runGoalActionLifecycle(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, liveSessionFixture("session-goal-actions", "")); err != nil {
		return err
	}
	ref := agenthost.GoalControlInput{WorkspaceID: "workspace-1", AgentSessionID: "session-goal-actions"}
	for index, command := range []struct{ action, objective, status string }{
		{action: "set", objective: "ship it", status: "active"},
		{action: "pause", status: "paused"},
		{action: "resume", status: "active"},
		{action: "clear"},
	} {
		ref.Action, ref.Objective = command.action, command.objective
		result, err := driver.GoalControl(ctx, ref)
		if err != nil {
			return fmt.Errorf("goal %s: %w", command.action, err)
		}
		if result.Revision != int64(index+1) {
			return fmt.Errorf("goal %s revision=%d", command.action, result.Revision)
		}
		if command.action == "clear" && result.Goal != nil {
			return fmt.Errorf("clear goal=%#v", result.Goal)
		}
		if command.status != "" && metadataString(result.Goal, "status") != command.status {
			return fmt.Errorf("goal %s result=%#v", command.action, result)
		}
		if result.PendingOperationID != "" || result.SyncStatus != storesqlite.GoalSyncStatusSynced {
			return fmt.Errorf("goal %s did not durably commit provider confirmation: %#v", command.action, result)
		}
	}
	if driver.Metrics().GoalControlCalls != 4 {
		return fmt.Errorf("goal control calls=%d", driver.Metrics().GoalControlCalls)
	}
	return nil
}

func runGoalReconcileObservation(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, liveSessionFixture("session-goal-reconcile", "")); err != nil {
		return err
	}
	if _, err := driver.GoalControl(ctx, agenthost.GoalControlInput{WorkspaceID: "workspace-1", AgentSessionID: "session-goal-reconcile", Action: "set", Objective: "reconcile me"}); err != nil {
		return err
	}
	result, err := driver.ReconcileGoal(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-goal-reconcile"})
	if err != nil {
		return fmt.Errorf("reconcile goal: %w", err)
	}
	if metadataString(result.Goal, "objective") != "reconcile me" || driver.Metrics().GoalReconcileCalls == 0 {
		return fmt.Errorf("reconcile result=%#v metrics=%#v", result, driver.Metrics())
	}
	return nil
}

func runGoalRevisionActorFence(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, liveSessionFixture("session-goal-fence", "")); err != nil {
		return err
	}
	inputs := []agenthost.GoalControlInput{
		{WorkspaceID: "workspace-1", AgentSessionID: "session-goal-fence", Action: "set", Objective: "first"},
		{WorkspaceID: "workspace-1", AgentSessionID: "session-goal-fence", Action: "clear"},
	}
	errs := make(chan error, len(inputs))
	for _, input := range inputs {
		input := input
		go func() { _, err := driver.GoalControl(ctx, input); errs <- err }()
	}
	for range inputs {
		if err := <-errs; err != nil {
			return fmt.Errorf("concurrent goal control: %w", err)
		}
	}
	state, err := driver.GetGoalState(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-goal-fence"})
	if err != nil {
		return err
	}
	if state.Revision != 2 || driver.Metrics().GoalControlCalls != 2 {
		return fmt.Errorf("goal fence state=%#v", state)
	}
	return nil
}

func runGoalInboxConsumerPreflight(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-goal-no-consumer", "")
	fixture.DisableGoalInbox = true
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	if err := driver.Recover(ctx); !errors.Is(err, agenthost.ErrGoalConsumerUnavailable) {
		return fmt.Errorf("missing goal consumer error=%v", err)
	}
	if steps := driver.Metrics().RecoverySteps; len(steps) != 0 {
		return fmt.Errorf("missing goal consumer ran recovery before preflight failure: %v", steps)
	}
	return nil
}

func runRuntimeCommitObserverFailure(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-observer-runtime", "turn-observer-runtime")
	fixture.Turn = &TurnSeed{TurnID: "turn-observer-runtime", Phase: canonical.TurnPhaseWaiting}
	fixture.Interaction = &InteractionSeed{
		RequestID: "request-observer-runtime", TurnID: "turn-observer-runtime",
		Kind: canonical.InteractionKindQuestion, Status: canonical.InteractionStatusPending,
	}
	fixture.FailCommitObserver = true
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	optionID := "approve"
	if _, err := driver.SubmitInteractive(ctx,
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-observer-runtime"},
		"request-observer-runtime", agenthost.SubmitInteractiveInput{TurnID: "turn-observer-runtime", OptionID: &optionID},
	); err != nil {
		return fmt.Errorf("observer failure escaped committed runtime command: %w", err)
	}
	if commits := driver.Metrics().RuntimeOperationCommits; commits < 2 {
		return fmt.Errorf("runtime committed deltas=%d, want prepare and completion", commits)
	}
	return nil
}

func runGoalOperationCommittedDeltas(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-observer-goal", "")
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	result, err := driver.GoalControl(ctx, agenthost.GoalControlInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-observer-goal",
		Action: "set", Objective: "observe durable goal",
	})
	if err != nil {
		return fmt.Errorf("goal control: %w", err)
	}
	metrics := driver.Metrics()
	if result.SyncStatus != storesqlite.GoalSyncStatusSynced || metrics.GoalOperationCommits < 3 {
		return fmt.Errorf("goal result=%#v committed deltas=%d, want prepare/dispatch/complete", result, metrics.GoalOperationCommits)
	}
	return nil
}

func metadataString(value map[string]any, key string) string {
	text, _ := value[key].(string)
	return text
}

func liveSessionFixture(sessionID, activeTurnID string) Fixture {
	return Fixture{Session: &SessionSeed{
		WorkspaceID: "workspace-1", AgentSessionID: sessionID, Provider: "codex",
		ProviderSessionID: "provider-" + sessionID, Cwd: "/workspace", Title: "Session title",
		ActiveTurnID: activeTurnID, InitialTitleEstablished: true, Live: true,
	}}
}
