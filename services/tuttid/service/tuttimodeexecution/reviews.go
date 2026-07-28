package tuttimodeexecution

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
)

const (
	defaultReviewerLeaseDuration = time.Minute
	reviewerVerdictCapability    = "tutti-goal-review.goal-review.verdict"
)

type GoalReviewStore interface {
	ListTuttiModeGoalReviews(context.Context, string, string) ([]executionbiz.GoalReview, error)
	ListTuttiModeGoalReviewAudit(context.Context, string, string) ([]executionbiz.ReviewAuditEntry, error)
	ListDispatchableTuttiModeGoalReviews(context.Context, string, time.Time) ([]executionbiz.GoalReview, error)
	ClaimTuttiModeGoalReview(context.Context, string, string, string, time.Time, time.Time) (bool, error)
	MarkTuttiModeGoalReviewDispatched(context.Context, string, string, string, string, string, time.Time) error
	FailTuttiModeGoalReview(context.Context, string, string, string, string, time.Time) error
	SettleTuttiModeGoalReviewWithoutVerdict(context.Context, string, string, string, string, time.Time) error
	AdmitTuttiModeReviewerVerdict(context.Context, executionbiz.ReviewerVerdictAdmission) (executionbiz.ReviewerVerdictResult, error)
	AdmitTuttiModeGoalReviewComplete(context.Context, executionbiz.GoalReviewCompleteAdmission) (executionbiz.GoalReviewCompleteResult, error)
	AdmitTuttiModeSwitchReviewToSelf(context.Context, executionbiz.SwitchReviewToSelfAdmission) (executionbiz.SwitchReviewToSelfResult, error)
}

type ReviewerSessionObservation struct {
	Busy bool
}

type ReviewerLaunch struct {
	WorkspaceID    string
	IssueID        string
	AgentTargetID  string
	SessionID      string
	ClientSubmitID string
	Prompt         string
	Capabilities   []string
}

type ReviewerDelivery struct {
	CanonicalSessionID string
	CanonicalTurnID    string
	Settled            bool
}

type ReviewerTarget interface {
	ObserveReviewerSession(context.Context, string, string) (ReviewerSessionObservation, error)
	SendReviewer(context.Context, ReviewerLaunch) (ReviewerDelivery, error)
	ReadReviewer(context.Context, ReviewerLaunch) (ReviewerDelivery, bool, error)
}

func (service Service) ListGoalReviews(
	ctx context.Context,
	workspaceID string,
	issueID string,
) ([]executionbiz.GoalReview, error) {
	store := service.reviewStore()
	if store == nil {
		return nil, ErrServiceUnavailable
	}
	return store.ListTuttiModeGoalReviews(
		ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(issueID),
	)
}

func (service Service) ListGoalReviewAudit(
	ctx context.Context,
	workspaceID string,
	issueID string,
) ([]executionbiz.ReviewAuditEntry, error) {
	store := service.reviewStore()
	if store == nil {
		return nil, ErrServiceUnavailable
	}
	return store.ListTuttiModeGoalReviewAudit(
		ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(issueID),
	)
}

func (service Service) Complete(
	ctx context.Context,
	input CompleteInput,
) (CompleteResult, error) {
	store := service.reviewStore()
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.IssueID = strings.TrimSpace(input.IssueID)
	input.SourceSessionID = strings.TrimSpace(input.SourceSessionID)
	input.CheckpointID = strings.TrimSpace(input.CheckpointID)
	input.RequestID = strings.TrimSpace(input.RequestID)
	input.Decision = strings.TrimSpace(input.Decision)
	input.DisagreementReason = strings.TrimSpace(input.DisagreementReason)
	if store == nil {
		return CompleteResult{}, ErrServiceUnavailable
	}
	if input.WorkspaceID == "" || input.IssueID == "" ||
		input.SourceSessionID == "" || input.CheckpointID == "" ||
		input.RequestID == "" || input.ExpectedGraphRevision < 1 ||
		input.Decision != "goal_satisfied" {
		return CompleteResult{}, executionbiz.ErrCompleteRejected
	}
	digest, err := goalReviewDigest(struct {
		CheckpointID          string `json:"checkpointId"`
		ExpectedGraphRevision int64  `json:"expectedGraphRevision"`
		Decision              string `json:"decision"`
		DisagreementReason    string `json:"disagreementReason"`
	}{
		input.CheckpointID, input.ExpectedGraphRevision,
		input.Decision, input.DisagreementReason,
	})
	if err != nil {
		return CompleteResult{}, err
	}
	result, err := store.AdmitTuttiModeGoalReviewComplete(
		ctx,
		executionbiz.GoalReviewCompleteAdmission{
			WorkspaceID: input.WorkspaceID, IssueID: input.IssueID,
			SourceSessionID:       input.SourceSessionID,
			CheckpointID:          input.CheckpointID,
			ExpectedGraphRevision: input.ExpectedGraphRevision,
			RequestID:             input.RequestID,
			InputSHA256:           digest,
			Decision:              input.Decision,
			DisagreementReason:    input.DisagreementReason,
			Now:                   service.now(),
			BeforeStep:            service.BeforeGoalReviewCommitStep,
		},
	)
	if err != nil {
		return CompleteResult{}, err
	}
	return CompleteResult{
		ExecutionID: result.ExecutionID, CheckpointID: result.CheckpointID,
		GraphRevision: result.GraphRevision, Decision: result.Decision,
		Replayed: result.Replayed,
	}, nil
}

func (service Service) SubmitReviewerVerdict(
	ctx context.Context,
	input ReviewerVerdictInput,
) (ReviewerVerdictResult, error) {
	store := service.reviewStore()
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.IssueID = strings.TrimSpace(input.IssueID)
	input.ReviewID = strings.TrimSpace(input.ReviewID)
	input.ReviewSessionID = strings.TrimSpace(input.ReviewSessionID)
	input.ReviewTurnID = strings.TrimSpace(input.ReviewTurnID)
	input.CheckpointID = strings.TrimSpace(input.CheckpointID)
	input.RequestID = strings.TrimSpace(input.RequestID)
	input.Verdict = strings.TrimSpace(input.Verdict)
	input.Summary = strings.TrimSpace(input.Summary)
	verdict := executionbiz.GoalReviewVerdict(input.Verdict)
	if store == nil {
		return ReviewerVerdictResult{}, ErrServiceUnavailable
	}
	if input.WorkspaceID == "" || input.IssueID == "" ||
		input.ReviewID == "" || input.ReviewSessionID == "" ||
		input.ReviewTurnID == "" || input.CheckpointID == "" ||
		input.RequestID == "" || input.ExpectedGraphRevision < 1 ||
		input.Summary == "" ||
		(verdict != executionbiz.GoalReviewVerdictSatisfied &&
			verdict != executionbiz.GoalReviewVerdictMoreWork &&
			verdict != executionbiz.GoalReviewVerdictUnknown) {
		return ReviewerVerdictResult{}, executionbiz.ErrReviewerVerdictRejected
	}
	digest, err := goalReviewDigest(struct {
		ReviewID              string `json:"reviewId"`
		ReviewSessionID       string `json:"reviewSessionId"`
		ReviewTurnID          string `json:"reviewTurnId"`
		CheckpointID          string `json:"checkpointId"`
		ExpectedGraphRevision int64  `json:"expectedGraphRevision"`
		Verdict               string `json:"verdict"`
		Summary               string `json:"summary"`
	}{
		input.ReviewID, input.ReviewSessionID, input.ReviewTurnID,
		input.CheckpointID, input.ExpectedGraphRevision, input.Verdict,
		input.Summary,
	})
	if err != nil {
		return ReviewerVerdictResult{}, err
	}
	result, err := store.AdmitTuttiModeReviewerVerdict(
		ctx,
		executionbiz.ReviewerVerdictAdmission{
			WorkspaceID: input.WorkspaceID, IssueID: input.IssueID,
			ReviewID: input.ReviewID, ReviewSessionID: input.ReviewSessionID,
			ReviewTurnID: input.ReviewTurnID, CheckpointID: input.CheckpointID,
			ExpectedGraphRevision: input.ExpectedGraphRevision,
			RequestID:             input.RequestID, InputSHA256: digest,
			Verdict: verdict, Summary: input.Summary, Now: service.now(),
			BeforeStep: service.BeforeGoalReviewCommitStep,
		},
	)
	if err != nil {
		return ReviewerVerdictResult{}, err
	}
	return ReviewerVerdictResult{
		ReviewID: result.ReviewID, Verdict: string(result.Verdict),
		Replayed: result.Replayed,
	}, nil
}

func (service Service) SwitchReviewToSelf(
	ctx context.Context,
	input SwitchReviewToSelfInput,
) (SwitchReviewToSelfResult, error) {
	store := service.reviewStore()
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.IssueID = strings.TrimSpace(input.IssueID)
	input.CheckpointID = strings.TrimSpace(input.CheckpointID)
	input.RequestID = strings.TrimSpace(input.RequestID)
	input.Reason = strings.TrimSpace(input.Reason)
	input.RequestedByActorID = strings.TrimSpace(input.RequestedByActorID)
	if store == nil {
		return SwitchReviewToSelfResult{}, ErrServiceUnavailable
	}
	if input.WorkspaceID == "" || input.IssueID == "" ||
		input.CheckpointID == "" || input.RequestID == "" ||
		input.Reason == "" || input.RequestedByActorID == "" ||
		input.ExpectedGraphRevision < 1 {
		return SwitchReviewToSelfResult{}, executionbiz.ErrSwitchReviewToSelfRejected
	}
	digest, err := goalReviewDigest(struct {
		CheckpointID          string `json:"checkpointId"`
		ExpectedGraphRevision int64  `json:"expectedGraphRevision"`
		Reason                string `json:"reason"`
		ActorID               string `json:"actorId"`
	}{
		input.CheckpointID, input.ExpectedGraphRevision,
		input.Reason, input.RequestedByActorID,
	})
	if err != nil {
		return SwitchReviewToSelfResult{}, err
	}
	result, err := store.AdmitTuttiModeSwitchReviewToSelf(
		ctx,
		executionbiz.SwitchReviewToSelfAdmission{
			WorkspaceID: input.WorkspaceID, IssueID: input.IssueID,
			CheckpointID:          input.CheckpointID,
			ExpectedGraphRevision: input.ExpectedGraphRevision,
			RequestID:             input.RequestID, InputSHA256: digest,
			Reason: input.Reason, RequestedByActorID: input.RequestedByActorID,
			Now: service.now(), BeforeStep: service.BeforeGoalReviewCommitStep,
		},
	)
	if err != nil {
		return SwitchReviewToSelfResult{}, err
	}
	return SwitchReviewToSelfResult{
		ExecutionID: result.ExecutionID, ReviewID: result.ReviewID,
		ReviewMode: result.ReviewMode, Replayed: result.Replayed,
	}, nil
}

func (service Service) ClaimReviewer(
	ctx context.Context,
	workspaceID string,
	reviewID string,
	leaseOwner string,
	leaseDuration time.Duration,
) (bool, error) {
	store := service.reviewStore()
	workspaceID = strings.TrimSpace(workspaceID)
	reviewID = strings.TrimSpace(reviewID)
	leaseOwner = strings.TrimSpace(leaseOwner)
	if store == nil {
		return false, ErrServiceUnavailable
	}
	if workspaceID == "" || reviewID == "" || leaseOwner == "" ||
		leaseDuration <= 0 {
		return false, executionbiz.ErrReviewerVerdictRejected
	}
	now := service.now()
	return store.ClaimTuttiModeGoalReview(
		ctx, workspaceID, reviewID, leaseOwner, now, now.Add(leaseDuration),
	)
}

func (service Service) RecoverReviewers(
	ctx context.Context,
	workspaceID string,
	leaseOwner string,
) error {
	store := service.reviewStore()
	workspaceID = strings.TrimSpace(workspaceID)
	leaseOwner = strings.TrimSpace(leaseOwner)
	if store == nil || service.ReviewerTargets == nil {
		return ErrServiceUnavailable
	}
	if workspaceID == "" || leaseOwner == "" {
		return executionbiz.ErrReviewerVerdictRejected
	}
	reviews, err := store.ListDispatchableTuttiModeGoalReviews(
		ctx, workspaceID, service.now(),
	)
	if err != nil {
		return err
	}
	var recoveryErrors []error
	for _, review := range reviews {
		if err := service.recoverOneReviewer(
			ctx, store, review, leaseOwner,
		); err != nil {
			recoveryErrors = append(recoveryErrors, fmt.Errorf(
				"recover Goal Review %q: %w", review.ID, err,
			))
		}
	}
	return errors.Join(recoveryErrors...)
}

func (service Service) recoverOneReviewer(
	ctx context.Context,
	store GoalReviewStore,
	review executionbiz.GoalReview,
	leaseOwner string,
) error {
	observation, err := service.ReviewerTargets.ObserveReviewerSession(
		ctx, review.WorkspaceID, review.SessionID,
	)
	if err != nil {
		return err
	}
	if observation.Busy {
		return nil
	}
	claimed, err := service.ClaimReviewer(
		ctx, review.WorkspaceID, review.ID, leaseOwner,
		defaultReviewerLeaseDuration,
	)
	if err != nil || !claimed {
		return err
	}
	launch := ReviewerLaunch{
		WorkspaceID: review.WorkspaceID, IssueID: review.IssueID,
		AgentTargetID: review.AgentTargetID, SessionID: review.SessionID,
		ClientSubmitID: review.ClientSubmitID,
		Prompt:         ReviewerPrompt(review),
		Capabilities:   []string{reviewerVerdictCapability},
	}
	if recovered, found, readErr := service.ReviewerTargets.ReadReviewer(
		ctx, launch,
	); readErr != nil {
		return readErr
	} else if found {
		if err := store.MarkTuttiModeGoalReviewDispatched(
			ctx, review.WorkspaceID, review.ID, leaseOwner,
			recovered.CanonicalSessionID, recovered.CanonicalTurnID,
			service.now(),
		); err != nil {
			return err
		}
		return service.reconcileReviewerSettlement(
			ctx, store, launch, recovered,
		)
	}
	delivery, sendErr := service.ReviewerTargets.SendReviewer(ctx, launch)
	if sendErr == nil {
		if err := store.MarkTuttiModeGoalReviewDispatched(
			ctx, review.WorkspaceID, review.ID, leaseOwner,
			delivery.CanonicalSessionID, delivery.CanonicalTurnID, service.now(),
		); err != nil {
			return err
		}
		return service.reconcileReviewerSettlement(
			ctx, store, launch, delivery,
		)
	}
	recovered, found, readErr := service.ReviewerTargets.ReadReviewer(ctx, launch)
	if readErr != nil {
		return errors.Join(sendErr, readErr)
	}
	if found {
		markErr := store.MarkTuttiModeGoalReviewDispatched(
			ctx, review.WorkspaceID, review.ID, leaseOwner,
			recovered.CanonicalSessionID, recovered.CanonicalTurnID,
			service.now(),
		)
		if markErr == nil {
			markErr = service.reconcileReviewerSettlement(
				ctx, store, launch, recovered,
			)
		}
		return errors.Join(sendErr, markErr)
	}
	failErr := store.FailTuttiModeGoalReview(
		ctx, review.WorkspaceID, review.ID, leaseOwner,
		"reviewer delivery failed", service.now(),
	)
	return errors.Join(sendErr, failErr)
}

func (service Service) reconcileReviewerSettlement(
	ctx context.Context,
	store GoalReviewStore,
	launch ReviewerLaunch,
	delivery ReviewerDelivery,
) error {
	observation := delivery
	if !observation.Settled {
		recovered, found, err := service.ReviewerTargets.ReadReviewer(ctx, launch)
		if err != nil {
			return err
		}
		if !found {
			return nil
		}
		observation = recovered
	}
	if !observation.Settled {
		return nil
	}
	return store.SettleTuttiModeGoalReviewWithoutVerdict(
		ctx,
		launch.WorkspaceID,
		observation.CanonicalSessionID,
		observation.CanonicalTurnID,
		"reviewer Turn settled without a structured verdict command",
		service.now(),
	)
}

func (service Service) SettleReviewerTurnWithoutVerdict(
	ctx context.Context,
	workspaceID string,
	sessionID string,
	turnID string,
	_ string,
) error {
	store := service.reviewStore()
	workspaceID = strings.TrimSpace(workspaceID)
	sessionID = strings.TrimSpace(sessionID)
	turnID = strings.TrimSpace(turnID)
	if store == nil {
		return ErrServiceUnavailable
	}
	if workspaceID == "" || sessionID == "" || turnID == "" {
		return executionbiz.ErrReviewerVerdictRejected
	}
	return store.SettleTuttiModeGoalReviewWithoutVerdict(
		ctx, workspaceID, sessionID, turnID,
		"reviewer Turn settled without a structured verdict command",
		service.now(),
	)
}

func (service Service) reviewStore() GoalReviewStore {
	if service.Reviews != nil {
		return service.Reviews
	}
	if store, ok := service.Store.(GoalReviewStore); ok {
		return store
	}
	return nil
}

func goalReviewDigest(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}
