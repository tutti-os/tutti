package conformance

var (
	createEmptySessionScenario          = Scenario{Name: "create empty session", run: runCreateEmptySession}
	createWithInitialContentScenario    = Scenario{Name: "create with initial content", run: runCreateWithInitialContent}
	createWithInitialGoalScenario       = Scenario{Name: "create with typed initial goal", run: runCreateWithInitialGoal}
	initialGoalExecutionPendingScenario = Scenario{Name: "initial Goal exposes execution pending", run: runInitialGoalExecutionPending}
	typedInitialGoalRailBarrierScenario = Scenario{
		Name: "typed initial goal waits for canonical rail initialization",
		run:  runTypedInitialGoalWaitsForCanonicalRailInitialization,
	}
	failedCanonicalInitializationScenario = Scenario{
		Name: "failed canonical initialization aborts unpublished runtime",
		run:  runFailedCanonicalInitializationAbortsUnpublishedRuntime,
	}
	createWithRailPlacementScenario              = Scenario{Name: "create with explicit rail placement", run: runCreateWithRailPlacement}
	createWithAuthoritativeRailPlacementScenario = Scenario{
		Name: "create with authoritative rail placement outside local project registry",
		run:  runCreateWithAuthoritativeRailPlacement,
	}
	resumePersistedSessionScenario                = Scenario{Name: "resume persisted session", run: runResumePersistedSession}
	failedResumePreservesRecoverableStateScenario = Scenario{
		Name: "failed resume preserves recoverable provider state",
		run:  runFailedResumePreservesRecoverableState,
	}
	sendInputScenario              = Scenario{Name: "send input", run: runSendInput}
	sendConnectorOnlyInputScenario = Scenario{Name: "send connector-only input", run: runSendConnectorOnlyInput}
	providerAcceptanceScenario     = Scenario{
		Name: "new turns require durable provider acceptance",
		run:  runNewTurnsRequireDurableProviderAcceptance,
	}
	providerlessCanonicalTerminalScenario = Scenario{
		Name: "providerless canonical terminal settles and replays submission",
		run:  runProviderlessCanonicalTerminalSettlesAndReplaysSubmission,
	}
	rejectedInitialSubmitScenario = Scenario{
		Name: "rejected initial submit discards runtime without completing canonical session",
		run:  runRejectedInitialSubmitDiscardsRuntime,
	}
	duplicateClientSubmitIDScenario     = Scenario{Name: "duplicate client submit id", run: runDuplicateClientSubmitID}
	exactTurnCancelScenario             = Scenario{Name: "exact turn cancel", run: runExactTurnCancel}
	unconfirmedTurnCancelScenario       = Scenario{Name: "exact turn cancel keeps delivery-unconfirmed intent pending", run: runUnconfirmedTurnCancel}
	interactiveResponseScenario         = Scenario{Name: "interactive response", run: runInteractiveResponse}
	interactiveResponseReusedIDScenario = Scenario{Name: "interactive response reuses provider request id across turns", run: runInteractiveResponseReusedRequestID}
	interactiveResponseRaceScenario     = Scenario{Name: "interactive response race", run: runInteractiveResponseRace}
	interactiveFollowUpRecoveryScenario = Scenario{Name: "interactive follow-up recovers through Host admission", run: runInteractiveFollowUpRecovery}
	planDecisionScenario                = Scenario{Name: "plan decision", run: runPlanDecision}
	initialTitleCASScenario             = Scenario{Name: "initial title cas", run: runInitialTitleCAS}
	getSessionScenario                  = Scenario{Name: "get session", run: runGetSession}
	listSessionTurnsScenario            = Scenario{Name: "list session turns", run: runListSessionTurns}
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
	purgeDeletedSessionsScenario     = Scenario{Name: "purge deleted sessions", run: runPurgeDeletedSessions}
	deleteAdmissionRejectionScenario = Scenario{
		Name: "delete admission rejection has no canonical side effects",
		run:  runDeleteAdmissionRejection,
	}
	deleteAdmissionExactClosureScenario = Scenario{
		Name: "delete admission receives exact canonical closure",
		run:  runDeleteAdmissionExactClosure,
	}
	deleteAdmissionReplanScenario = Scenario{
		Name: "delete admission guards changed closure before additional runtime close",
		run:  runDeleteAdmissionReplan,
	}
)

// Scenarios returns the lifecycle surface that every host adapter must support.
func Scenarios() []Scenario {
	return []Scenario{
		createEmptySessionScenario,
		createWithInitialContentScenario,
		createWithInitialGoalScenario,
		initialGoalExecutionPendingScenario,
		typedInitialGoalRailBarrierScenario,
		failedCanonicalInitializationScenario,
		createWithRailPlacementScenario,
		createWithAuthoritativeRailPlacementScenario,
		resumePersistedSessionScenario,
		failedResumePreservesRecoverableStateScenario,
		sendInputScenario,
		sendConnectorOnlyInputScenario,
		guidanceTargetRequiredScenario,
		guidanceExactTargetScenario,
		guidanceTargetMismatchScenario,
		providerAcceptanceScenario,
		providerlessCanonicalTerminalScenario,
		rejectedInitialSubmitScenario,
		duplicateClientSubmitIDScenario,
		exactTurnCancelScenario,
		interactiveResponseScenario,
		interactiveResponseReusedIDScenario,
		interactiveResponseRaceScenario,
		planDecisionScenario,
		initialTitleCASScenario,
		getSessionScenario,
		listSessionTurnsScenario,
		historicalAndLiveSettingsScenario,
		pinSessionScenario,
		deleteSessionScenario,
		deleteLiveOnlySessionScenario,
		deleteAdmissionRejectionScenario,
		deleteAdmissionExactClosureScenario,
		deleteAdmissionReplanScenario,
		purgeDeletedSessionsScenario,
	}
}

func ResumePolicyScenarios() []Scenario {
	return []Scenario{
		{Name: "reject provider session that never established", run: runRejectUnestablishedProviderSession},
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

// RailPlacementRecoveryScenarios verifies the Host-owned immutable rail proof
// used by application adapters during idempotent recovery.
func RailPlacementRecoveryScenarios() []RailPlacementRecoveryScenario {
	return []RailPlacementRecoveryScenario{{
		Name: "recover canonical session only on matching rail",
		run:  runRecoverCanonicalSessionOnlyOnMatchingRail,
	}}
}

// DeletionAdmissionScenarios verifies the provider-neutral guard around the
// exact canonical closure owned and replanned by Host.
func DeletionAdmissionScenarios() []Scenario {
	return []Scenario{
		deleteAdmissionRejectionScenario,
		deleteAdmissionExactClosureScenario,
		deleteAdmissionReplanScenario,
	}
}

// CoordinatorScenarios covers commands and recovery behavior owned by the Host
// coordinator rather than the application-core session lifecycle.
func CoordinatorScenarios() []Scenario {
	return []Scenario{
		exactTurnCancelScenario,
		unconfirmedTurnCancelScenario,
		interactiveResponseScenario,
		interactiveResponseReusedIDScenario,
		interactiveResponseRaceScenario,
		interactiveFollowUpRecoveryScenario,
		planDecisionScenario,
		{Name: "recover operations before stale turns", run: runRecoveryOrder},
	}
}

func GoalScenarios() []Scenario {
	return []Scenario{
		{Name: "direct and typed goal equivalence", run: runDirectAndTypedGoalEquivalence},
		{Name: "goal action lifecycle", run: runGoalActionLifecycle},
		{Name: "goal status control preserves durable goal without provider observation", run: runGoalControlPreservesDurableGoalWithoutProviderObservation},
		{Name: "duplicate goal client submit id", run: runDuplicateGoalClientSubmitID},
		{Name: "provider authored goal adoption", run: runProviderAuthoredGoalAdoption},
		{Name: "provider authored goal active conflict", run: runProviderAuthoredGoalActiveConflict},
		{Name: "provider authored goal terminal advancement", run: runProviderAuthoredGoalTerminalAdvancement},
		{Name: "provider authored goal cleared advancement", run: runProviderAuthoredGoalClearedAdvancement},
		{Name: "provider authored goal stale after clear", run: runProviderAuthoredGoalStaleAfterClear},
		{Name: "goal reconcile observation", run: runGoalReconcileObservation},
		{Name: "goal revision actor fence", run: runGoalRevisionActorFence},
		{Name: "goal generation fence preserves newer goal", run: runGoalGenerationFencePreservesNewerGoal},
		{Name: "restart completes offline goal fence without replay", run: runRestartCompletesOfflineGoalFenceWithoutReplay},
		{Name: "accepted goal control waits without replay", run: runAcceptedGoalControlWaitsWithoutReplay},
		{Name: "turnless goal session resumes after disconnect", run: runTurnlessGoalSessionResumesAfterDisconnect},
		{Name: "goal intent accepted before runtime readiness failure", run: runGoalIntentAcceptedBeforeRuntimeReadinessFailure},
		{Name: "goal inbox consumer preflight", run: runGoalInboxConsumerPreflight},
	}
}

// SessionForkScenarios covers the optional native fork capability without
// weakening the base Driver contract for providers that do not implement it.
func SessionForkScenarios() []SessionForkScenario {
	return []SessionForkScenario{
		{Name: "settled through-turn binding can fork while source is active", run: runActiveSourceFork},
		{Name: "through-turn fork replay does not redispatch provider", run: runThroughTurnForkReplay},
		{Name: "provider-accepted fork recovers local commit", run: runProviderAcceptedForkRecovery},
		{Name: "permanently inconsistent provider-accepted fork is quarantined", run: runPermanentlyInconsistentForkRecovery},
	}
}

// DeletedSessionLifecycleScenarios verifies the lifecycle boundary separately
// from retention purge: deletion produces a restorable canonical tombstone,
// and restore never starts or resumes provider work.
func DeletedSessionLifecycleScenarios() []DeletedSessionLifecycleScenario {
	return []DeletedSessionLifecycleScenario{{
		Name: "lossless deleted session restores without provider resume",
		run:  runLosslessDeletedSessionRestore,
	}}
}

// InteractionTreeScenarios covers the canonical cross-session interaction
// read without expanding the base lifecycle Driver contract.
func InteractionTreeScenarios() []InteractionTreeScenario {
	return []InteractionTreeScenario{{
		Name: "root interaction tree includes descendant latest turns",
		run:  runInteractionTreeSnapshot,
	}}
}

// SideConversationScenarios fixes the provider-neutral contract: the source
// remains untouched, Side output is transient, a Side survives source Turn
// settlement, and explicit close releases the child.
func SideConversationScenarios() []SideConversationScenario {
	return []SideConversationScenario{{
		Name: "active parent side stays transient",
		run:  runActiveParentSideStaysTransient,
	}}
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
		createWithInitialGoalScenario,
		initialGoalExecutionPendingScenario,
		typedInitialGoalRailBarrierScenario,
		failedCanonicalInitializationScenario,
		createWithRailPlacementScenario,
		createWithAuthoritativeRailPlacementScenario,
		resumePersistedSessionScenario,
		failedResumePreservesRecoverableStateScenario,
		sendInputScenario,
		sendConnectorOnlyInputScenario,
		guidanceTargetRequiredScenario,
		guidanceExactTargetScenario,
		guidanceTargetMismatchScenario,
		providerAcceptanceScenario,
		providerlessCanonicalTerminalScenario,
		rejectedInitialSubmitScenario,
		duplicateClientSubmitIDScenario,
		initialTitleCASScenario,
		getSessionScenario,
		listSessionTurnsScenario,
		historicalAndLiveSettingsScenario,
		pinSessionScenario,
		deleteSessionScenario,
		deleteLiveOnlySessionScenario,
		deleteAdmissionRejectionScenario,
		deleteAdmissionExactClosureScenario,
		deleteAdmissionReplanScenario,
		purgeDeletedSessionsScenario,
	}
}
