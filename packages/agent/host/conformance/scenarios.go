package conformance

var (
	createEmptySessionScenario          = Scenario{Name: "create empty session", run: runCreateEmptySession}
	createWithInitialContentScenario    = Scenario{Name: "create with initial content", run: runCreateWithInitialContent}
	resumePersistedSessionScenario      = Scenario{Name: "resume persisted session", run: runResumePersistedSession}
	sendInputScenario                   = Scenario{Name: "send input", run: runSendInput}
	duplicateClientSubmitIDScenario     = Scenario{Name: "duplicate client submit id", run: runDuplicateClientSubmitID}
	exactTurnCancelScenario             = Scenario{Name: "exact turn cancel", run: runExactTurnCancel}
	interactiveResponseScenario         = Scenario{Name: "interactive response", run: runInteractiveResponse}
	interactiveResponseReusedIDScenario = Scenario{Name: "interactive response reuses provider request id across turns", run: runInteractiveResponseReusedRequestID}
	interactiveResponseRaceScenario     = Scenario{Name: "interactive response race", run: runInteractiveResponseRace}
	planDecisionScenario                = Scenario{Name: "plan decision", run: runPlanDecision}
	initialTitleCASScenario             = Scenario{Name: "initial title cas", run: runInitialTitleCAS}
	getSessionScenario                  = Scenario{Name: "get session", run: runGetSession}
	historicalAndLiveSettingsScenario   = Scenario{
		Name: "historical and live settings",
		run:  runHistoricalAndLiveSettings,
	}
	pinSessionScenario            = Scenario{Name: "pin session", run: runPinSession}
	deleteSessionScenario         = Scenario{Name: "delete session", run: runDeleteSession}
	deleteLiveOnlySessionScenario = Scenario{
		Name: "delete live session before canonical report",
		run:  runDeleteLiveSessionBeforeCanonicalReport,
	}
	purgeDeletedSessionsScenario    = Scenario{Name: "purge deleted sessions", run: runPurgeDeletedSessions}
	retryTurnCreatesLineageScenario = Scenario{
		Name: "retry turn creates lineage turn",
		run:  runRetryTurnCreatesLineageTurn,
	}
)

// Scenarios returns the lifecycle surface that every host adapter must support.
func Scenarios() []Scenario {
	return []Scenario{
		createEmptySessionScenario,
		createWithInitialContentScenario,
		resumePersistedSessionScenario,
		sendInputScenario,
		duplicateClientSubmitIDScenario,
		exactTurnCancelScenario,
		interactiveResponseScenario,
		interactiveResponseReusedIDScenario,
		interactiveResponseRaceScenario,
		planDecisionScenario,
		initialTitleCASScenario,
		getSessionScenario,
		historicalAndLiveSettingsScenario,
		pinSessionScenario,
		deleteSessionScenario,
		deleteLiveOnlySessionScenario,
		purgeDeletedSessionsScenario,
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

// CoordinatorScenarios covers commands and recovery behavior owned by the Host
// coordinator rather than the application-core session lifecycle.
func CoordinatorScenarios() []Scenario {
	return []Scenario{
		exactTurnCancelScenario,
		interactiveResponseScenario,
		interactiveResponseReusedIDScenario,
		interactiveResponseRaceScenario,
		planDecisionScenario,
		{Name: "recover operations before stale turns and worktree sweep", run: runRecoveryOrder},
		{Name: "worktree sweep failure propagates", run: runWorktreeSweepFailure},
	}
}

func GoalScenarios() []Scenario {
	return []Scenario{
		{Name: "direct and typed goal equivalence", run: runDirectAndTypedGoalEquivalence},
		{Name: "goal action lifecycle", run: runGoalActionLifecycle},
		{Name: "duplicate goal client submit id", run: runDuplicateGoalClientSubmitID},
		{Name: "goal reconcile observation", run: runGoalReconcileObservation},
		{Name: "goal revision actor fence", run: runGoalRevisionActorFence},
		{Name: "accepted goal control waits without replay", run: runAcceptedGoalControlWaitsWithoutReplay},
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

// ApplicationCoreScenarios covers the session lifecycle that can execute
// directly through Host without the coordinator-owned command scenarios.
func ApplicationCoreScenarios() []Scenario {
	return []Scenario{
		createEmptySessionScenario,
		createWithInitialContentScenario,
		resumePersistedSessionScenario,
		sendInputScenario,
		duplicateClientSubmitIDScenario,
		initialTitleCASScenario,
		getSessionScenario,
		historicalAndLiveSettingsScenario,
		pinSessionScenario,
		deleteSessionScenario,
		deleteLiveOnlySessionScenario,
		purgeDeletedSessionsScenario,
		retryTurnCreatesLineageScenario,
	}
}

// RetryTurnScenarios covers the Retry/Edit lifecycle contract.
func RetryTurnScenarios() []Scenario {
	return []Scenario{
		retryTurnCreatesLineageScenario,
	}
}
