// Package agentactivity re-exports the agent activity persistence contract,
// which now lives in the embeddable packages/agent/store-sqlite module. The
// aliases keep tuttid-internal import paths and type identities stable.
package agentactivity

import (
	agentstore "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type Repository = agentstore.Repository

type ClearSessionsResult = agentstore.ClearSessionsResult
type CountSessionSectionInput = agentstore.CountSessionSectionInput
type DeleteSessionSectionInput = agentstore.DeleteSessionSectionInput
type DeleteSessionSectionResult = agentstore.DeleteSessionSectionResult

type MessageOrder = agentstore.MessageOrder

const (
	MessageOrderAsc      = agentstore.MessageOrderAsc
	MessageOrderDesc     = agentstore.MessageOrderDesc
	PinnedSessionPageKey = agentstore.PinnedSessionPageKey
)

type ListSessionMessagesInput = agentstore.ListSessionMessagesInput

type ListWorkspaceGeneratedFilesInput = agentstore.ListWorkspaceGeneratedFilesInput

type GeneratedFile = agentstore.GeneratedFile

type GeneratedFileList = agentstore.GeneratedFileList

type ListSessionSectionInput = agentstore.ListSessionSectionInput
type SessionSectionCount = agentstore.SessionSectionCount

type SessionSectionPage = agentstore.SessionSectionPage

type Session = agentstore.Session
type SessionMetadata = agentstore.SessionMetadata
type SessionUsage = agentstore.SessionUsage
type SessionUsageContextWindow = agentstore.SessionUsageContextWindow
type SessionUsageQuota = agentstore.SessionUsageQuota
type SessionBackgroundAgents = agentstore.SessionBackgroundAgents
type SessionBackgroundAgentItem = agentstore.SessionBackgroundAgentItem
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

type MessagePage = agentstore.MessagePage

type Turn = agentstore.Turn

type TurnTransition = agentstore.TurnTransition

type Interaction = agentstore.Interaction

type InteractionUpsert = agentstore.InteractionUpsert

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
type CompletePlanDecisionRuntimeOperationInput = agentstore.CompletePlanDecisionRuntimeOperationInput
type RuntimeOperationEvent = agentstore.RuntimeOperationEvent
type RuntimeOperationCompletion = agentstore.RuntimeOperationCompletion
type SubmitClaim = agentstore.SubmitClaim
type SubmitClaimPrepare = agentstore.SubmitClaimPrepare

var (
	ErrRuntimeOperationConflict     = agentstore.ErrRuntimeOperationConflict
	ErrRuntimeOperationNotClaimable = agentstore.ErrRuntimeOperationNotClaimable
	ErrRuntimeOperationLeaseLost    = agentstore.ErrRuntimeOperationLeaseLost
	ErrRuntimeOperationSubjectState = agentstore.ErrRuntimeOperationSubjectState
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

	InteractionKindApproval = agentstore.InteractionKindApproval
	InteractionKindQuestion = agentstore.InteractionKindQuestion
	InteractionKindPlan     = agentstore.InteractionKindPlan

	InteractionStatusPending    = agentstore.InteractionStatusPending
	InteractionStatusAnswered   = agentstore.InteractionStatusAnswered
	InteractionStatusSuperseded = agentstore.InteractionStatusSuperseded

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
)
