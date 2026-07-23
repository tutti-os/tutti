// Package agentactivity re-exports the agent activity persistence contract,
// which now lives in the embeddable packages/agent/store-sqlite module. The
// aliases keep tuttid-internal import paths and type identities stable.
package agentactivity

import (
	agentstore "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type Repository = agentstore.Repository
type SessionTurnSummaryReader = agentstore.SessionTurnSummaryReader

type ClearSessionsResult = agentstore.ClearSessionsResult
type PurgeDeletedSessionsInput = agentstore.PurgeDeletedSessionsInput
type PurgedSession = agentstore.PurgedSession
type PurgeDeletedSessionsResult = agentstore.PurgeDeletedSessionsResult
type ListSessionSectionDeletionCandidatesInput = agentstore.ListSessionSectionDeletionCandidatesInput
type SessionSectionDeletionCandidates = agentstore.SessionSectionDeletionCandidates
type DeleteSessionsBatchInput = agentstore.DeleteSessionsBatchInput
type DeleteSessionsPlan = agentstore.DeleteSessionsPlan
type DeleteSessionsBatchResult = agentstore.DeleteSessionsBatchResult
type DeleteSessionResult = agentstore.DeleteSessionResult
type TransactionDelta = agentstore.TransactionDelta
type TransactionMutation = agentstore.TransactionMutation

const MutationEntitySession = agentstore.MutationEntitySession

type MessageOrder = agentstore.MessageOrder

const (
	MessageOrderAsc      = agentstore.MessageOrderAsc
	MessageOrderDesc     = agentstore.MessageOrderDesc
	PinnedSessionPageKey = agentstore.PinnedSessionPageKey
)

type ListSessionMessagesInput = agentstore.ListSessionMessagesInput

type ListWorkspaceGeneratedFileTurnsInput = agentstore.ListWorkspaceGeneratedFileTurnsInput
type GeneratedFileTurnChange = agentstore.GeneratedFileTurnChange
type GeneratedFileTurn = agentstore.GeneratedFileTurn
type GeneratedFileTurnList = agentstore.GeneratedFileTurnList

type ListSessionSectionInput = agentstore.ListSessionSectionInput

type ListSessionSectionsInput = agentstore.ListSessionSectionsInput

type ListSessionsPageInput = agentstore.ListSessionsPageInput

type SessionListPage = agentstore.SessionListPage

type SessionSectionPage = agentstore.SessionSectionPage

type SessionSectionsPage = agentstore.SessionSectionsPage

type Session = agentstore.Session
type SessionMetadata = agentstore.SessionMetadata
type SessionUsage = agentstore.SessionUsage
type SessionUsageContextWindow = agentstore.SessionUsageContextWindow
type SessionUsageQuota = agentstore.SessionUsageQuota
type SessionGoal = agentstore.SessionGoal

func JoinSessionRuntimeContext(metadata SessionMetadata, internal map[string]any) map[string]any {
	return agentstore.JoinSessionRuntimeContext(metadata, internal)
}

func SplitSessionRuntimeContext(runtimeContext map[string]any) (SessionMetadata, map[string]any, error) {
	return agentstore.SplitSessionRuntimeContext(runtimeContext)
}

type SessionStateReport = agentstore.SessionStateReport

type StateReportResult = agentstore.StateReportResult

type ActivityStateReport = agentstore.ActivityStateReport

type ActivityStateReportResult = agentstore.ActivityStateReportResult

type SessionMessageReport = agentstore.SessionMessageReport

type MessageUpdate = agentstore.MessageUpdate

type MessageReportResult = agentstore.MessageReportResult

type Message = agentstore.Message
type MessageSemantics = agentstore.MessageSemantics

type MessagePage = agentstore.MessagePage

type Turn = agentstore.Turn
type SessionTurnCursor = agentstore.SessionTurnCursor
type ListSessionTurnSummariesInput = agentstore.ListSessionTurnSummariesInput
type SessionTurnSummary = agentstore.SessionTurnSummary
type SessionTurnSummaryPage = agentstore.SessionTurnSummaryPage
type CapabilityReference = agentstore.CapabilityReference

type TurnTransition = agentstore.TurnTransition
type TurnRelation = agentstore.TurnRelation
type RootProviderTurnTransition = agentstore.RootProviderTurnTransition

type Interaction = agentstore.Interaction

type InteractionUpsert = agentstore.InteractionUpsert
type InteractionTransitionResult = agentstore.InteractionTransitionResult

type ListSessionInteractionsInput = agentstore.ListSessionInteractionsInput

type StaleTurnSettlement = agentstore.StaleTurnSettlement

type RuntimeOperation = agentstore.RuntimeOperation
type RuntimeOperationPrepare = agentstore.RuntimeOperationPrepare
type ListClaimableRuntimeOperationsInput = agentstore.ListClaimableRuntimeOperationsInput
type ClaimRuntimeOperationLeaseInput = agentstore.ClaimRuntimeOperationLeaseInput
type ReleaseOrFailRuntimeOperationInput = agentstore.ReleaseOrFailRuntimeOperationInput
type CheckpointRuntimeOperationInput = agentstore.CheckpointRuntimeOperationInput
type CompleteInteractiveRuntimeOperationInput = agentstore.CompleteInteractiveRuntimeOperationInput
type CompleteCancelRuntimeOperationInput = agentstore.CompleteCancelRuntimeOperationInput
type CancelRuntimeOperationTargetOutcome = agentstore.CancelRuntimeOperationTargetOutcome
type CompletePlanDecisionRuntimeOperationInput = agentstore.CompletePlanDecisionRuntimeOperationInput
type RuntimeOperationEvent = agentstore.RuntimeOperationEvent
type RuntimeOperationCompletion = agentstore.RuntimeOperationCompletion
type SessionGoalState = agentstore.SessionGoalState
type GoalControlOperation = agentstore.GoalControlOperation
type GoalControlOperationPrepare = agentstore.GoalControlOperationPrepare
type GoalControlOperationComplete = agentstore.GoalControlOperationComplete
type GoalControlOperationAcknowledge = agentstore.GoalControlOperationAcknowledge
type GoalObservationReconcile = agentstore.GoalObservationReconcile
type GoalObservationFence = agentstore.GoalObservationFence
type GoalTerminalIncidentInput = agentstore.GoalTerminalIncidentInput
type ListClaimableGoalControlOperationsInput = agentstore.ListClaimableGoalControlOperationsInput
type ClaimGoalControlOperationInput = agentstore.ClaimGoalControlOperationInput
type ReleaseGoalControlOperationInput = agentstore.ReleaseGoalControlOperationInput
type GoalControlOperationEvidence = agentstore.GoalControlOperationEvidence
type WakeGoalControlOperationInput = agentstore.WakeGoalControlOperationInput
type EnsureGoalRepairOperationInput = agentstore.EnsureGoalRepairOperationInput
type GoalReconcileInboxItem = agentstore.GoalReconcileInboxItem
type ClaimGoalReconcileInboxInput = agentstore.ClaimGoalReconcileInboxInput
type ReleaseGoalReconcileInboxInput = agentstore.ReleaseGoalReconcileInboxInput
type GoalProvenanceBinding = agentstore.GoalProvenanceBinding
type BindGoalProvenanceInput = agentstore.BindGoalProvenanceInput
type LookupGoalProvenanceInput = agentstore.LookupGoalProvenanceInput
type SubmitClaim = agentstore.SubmitClaim
type SubmitClaimPrepare = agentstore.SubmitClaimPrepare

var (
	ErrRuntimeOperationConflict         = agentstore.ErrRuntimeOperationConflict
	ErrRuntimeOperationIdentityMismatch = agentstore.ErrRuntimeOperationIdentityMismatch
	ErrRuntimeOperationNotClaimable     = agentstore.ErrRuntimeOperationNotClaimable
	ErrRuntimeOperationLeaseLost        = agentstore.ErrRuntimeOperationLeaseLost
	ErrRuntimeOperationSubjectState     = agentstore.ErrRuntimeOperationSubjectState
	ErrGoalOperationConflict            = agentstore.ErrGoalOperationConflict
	ErrGoalStateAbsent                  = agentstore.ErrGoalStateAbsent
	ErrGoalReconcileConflict            = agentstore.ErrGoalReconcileConflict
)

const (
	TurnPhaseSubmitted = agentstore.TurnPhaseSubmitted
	TurnPhaseRunning   = agentstore.TurnPhaseRunning
	TurnPhaseWaiting   = agentstore.TurnPhaseWaiting
	TurnPhaseSettling  = agentstore.TurnPhaseSettling
	TurnPhaseSettled   = agentstore.TurnPhaseSettled

	TurnOutcomeCompleted   = agentstore.TurnOutcomeCompleted
	TurnOutcomeFailed      = agentstore.TurnOutcomeFailed
	TurnOutcomeCanceled    = agentstore.TurnOutcomeCanceled
	TurnOutcomeInterrupted = agentstore.TurnOutcomeInterrupted

	SessionKindRoot  = agentstore.SessionKindRoot
	SessionKindChild = agentstore.SessionKindChild

	TurnOriginUserPrompt        = agentstore.TurnOriginUserPrompt
	TurnOriginGoalArm           = agentstore.TurnOriginGoalArm
	TurnOriginGoalContinuation  = agentstore.TurnOriginGoalContinuation
	TurnOriginProviderInitiated = agentstore.TurnOriginProviderInitiated
	TurnOriginLegacyUnknown     = agentstore.TurnOriginLegacyUnknown

	InteractionKindApproval = agentstore.InteractionKindApproval
	InteractionKindQuestion = agentstore.InteractionKindQuestion
	InteractionKindPlan     = agentstore.InteractionKindPlan

	InteractionStatusPending    = agentstore.InteractionStatusPending
	InteractionStatusAnswered   = agentstore.InteractionStatusAnswered
	InteractionStatusSuperseded = agentstore.InteractionStatusSuperseded

	InteractionTransitionApplied        = agentstore.InteractionTransitionApplied
	InteractionTransitionAlreadyApplied = agentstore.InteractionTransitionAlreadyApplied
	InteractionTransitionConflict       = agentstore.InteractionTransitionConflict

	RuntimeOperationKindInteractiveResponse    = agentstore.RuntimeOperationKindInteractiveResponse
	RuntimeOperationKindCancelTurn             = agentstore.RuntimeOperationKindCancelTurn
	RuntimeOperationKindPlanDecision           = agentstore.RuntimeOperationKindPlanDecision
	RuntimeOperationStatusPrepared             = agentstore.RuntimeOperationStatusPrepared
	RuntimeOperationStatusLeased               = agentstore.RuntimeOperationStatusLeased
	RuntimeOperationStatusCompleted            = agentstore.RuntimeOperationStatusCompleted
	RuntimeOperationStatusFailed               = agentstore.RuntimeOperationStatusFailed
	RuntimeOperationResultAnswered             = agentstore.RuntimeOperationResultAnswered
	RuntimeOperationResultSuperseded           = agentstore.RuntimeOperationResultSuperseded
	RuntimeOperationResultCanceled             = agentstore.RuntimeOperationResultCanceled
	RuntimeOperationResultAlreadySettled       = agentstore.RuntimeOperationResultAlreadySettled
	RuntimeOperationResultApplied              = agentstore.RuntimeOperationResultApplied
	RuntimeOperationResultFailed               = agentstore.RuntimeOperationResultFailed
	RuntimeOperationEventInteractiveCompleted  = agentstore.RuntimeOperationEventInteractiveCompleted
	RuntimeOperationEventTurnCanceled          = agentstore.RuntimeOperationEventTurnCanceled
	RuntimeOperationEventPlanDecisionPending   = agentstore.RuntimeOperationEventPlanDecisionPending
	RuntimeOperationEventPlanDecisionCompleted = agentstore.RuntimeOperationEventPlanDecisionCompleted

	GoalSyncStatusPending         = agentstore.GoalSyncStatusPending
	GoalSyncStatusApplying        = agentstore.GoalSyncStatusApplying
	GoalSyncStatusSynced          = agentstore.GoalSyncStatusSynced
	GoalSyncStatusDiverged        = agentstore.GoalSyncStatusDiverged
	GoalSyncStatusUnknown         = agentstore.GoalSyncStatusUnknown
	GoalSyncStatusFailed          = agentstore.GoalSyncStatusFailed
	GoalOperationStatusPrepared   = agentstore.GoalOperationStatusPrepared
	GoalOperationStatusDispatched = agentstore.GoalOperationStatusDispatched
	GoalOperationStatusCompleted  = agentstore.GoalOperationStatusCompleted
	GoalOperationStatusFailed     = agentstore.GoalOperationStatusFailed
	GoalOperationStatusSuperseded = agentstore.GoalOperationStatusSuperseded
	GoalProviderPhasePrepared     = agentstore.GoalProviderPhasePrepared
	GoalProviderPhaseDispatched   = agentstore.GoalProviderPhaseDispatched
	GoalProviderPhaseAccepted     = agentstore.GoalProviderPhaseAccepted
	GoalProviderPhaseApplied      = agentstore.GoalProviderPhaseApplied
	GoalProviderPhaseUnknown      = agentstore.GoalProviderPhaseUnknown
)
