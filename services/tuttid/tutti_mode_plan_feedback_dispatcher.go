package main

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	tuttimodeplanservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeplan"
)

const tuttiModePlanFeedbackDispatchTimeout = 2 * time.Minute

type tuttiModePlanFeedbackTurnLinkStore interface {
	AppendWorkspaceWorkflowTurnLink(context.Context, string, workflowbiz.WorkflowTurnLink) error
}

// tuttiModePlanFeedbackDispatcher turns a durable "request changes" decision
// into a new turn on the source Agent session so `tutti plan revise` actually
// happens without the Agent having to poll. The decision is already committed
// before dispatch; failures are logged and recoverable through plan get/wait.
type tuttiModePlanFeedbackDispatcher struct {
	Agents    *agentservice.Service
	TurnLinks tuttiModePlanFeedbackTurnLinkStore
	// Synchronous is used by tests; production dispatch is fire-and-forget so
	// the user's decide response never waits on provider acceptance.
	Synchronous bool
	Now         func() time.Time
}

func (d *tuttiModePlanFeedbackDispatcher) DispatchPlanRevisionFeedback(
	_ context.Context,
	input tuttimodeplanservice.PlanRevisionFeedbackInput,
) error {
	if d == nil || d.Agents == nil {
		return fmt.Errorf("tutti mode plan feedback dispatcher is unavailable")
	}
	if d.Synchronous {
		d.dispatch(input)
		return nil
	}
	go d.dispatch(input)
	return nil
}

func (d *tuttiModePlanFeedbackDispatcher) dispatch(input tuttimodeplanservice.PlanRevisionFeedbackInput) {
	ctx, cancel := context.WithTimeout(context.Background(), tuttiModePlanFeedbackDispatchTimeout)
	defer cancel()
	prompt := tuttiModePlanFeedbackPrompt(input)
	result, err := d.Agents.SendInput(ctx, input.WorkspaceID, input.SourceSessionID, agentservice.SendInput{
		Content:        []agentservice.PromptContentBlock{{Type: "text", Text: prompt}},
		ClientSubmitID: "tutti-plan-feedback:" + input.CheckpointID,
		Metadata: map[string]any{
			"tuttiModePlanWorkflowId":   input.WorkflowID,
			"tuttiModePlanCheckpointId": input.CheckpointID,
		},
	})
	if err != nil {
		slog.Warn("tutti mode plan feedback dispatch failed",
			"event", "tutti_mode_plan.feedback_dispatch_failed",
			"workspaceId", input.WorkspaceID,
			"workflowId", input.WorkflowID,
			"checkpointId", input.CheckpointID,
			"sourceSessionId", input.SourceSessionID,
			"error", err)
		return
	}
	turnID := strings.TrimSpace(result.TurnID)
	slog.Info("tutti mode plan feedback dispatched",
		"event", "tutti_mode_plan.feedback_dispatched",
		"workspaceId", input.WorkspaceID,
		"workflowId", input.WorkflowID,
		"checkpointId", input.CheckpointID,
		"turnId", turnID)
	if turnID == "" || d.TurnLinks == nil {
		return
	}
	now := time.Now().UTC()
	if d.Now != nil {
		now = d.Now().UTC()
	}
	if linkErr := d.TurnLinks.AppendWorkspaceWorkflowTurnLink(ctx, input.WorkspaceID, workflowbiz.WorkflowTurnLink{
		WorkflowID: input.WorkflowID,
		TurnID:     turnID,
		Relation:   workflowbiz.TurnRelationFeedback,
		CreatedAt:  now,
	}); linkErr != nil {
		slog.Warn("tutti mode plan feedback turn link failed",
			"event", "tutti_mode_plan.feedback_turn_link_failed",
			"workflowId", input.WorkflowID,
			"turnId", turnID,
			"error", linkErr)
	}
}

func tuttiModePlanFeedbackPrompt(input tuttimodeplanservice.PlanRevisionFeedbackInput) string {
	return fmt.Sprintf(`The user reviewed your Tutti Mode plan and requested changes.

Workflow ID: %s
Rejected checkpoint ID: %s

User feedback:
%s

Revise the plan now:
1. Update the complete tutti-mode-plan/v1 Markdown document (plan narrative plus the full task graph in the tasks frontmatter) to address the feedback.
2. Submit it with: tutti plan revise --workflow-id %s --file <absolute path to the updated document> --request-id <new stable id>
3. Observe the new review decision with: tutti plan wait --workflow-id %s --checkpoint-id <checkpoint id returned by revise>`,
		input.WorkflowID,
		input.CheckpointID,
		strings.TrimSpace(input.Feedback),
		input.WorkflowID,
		input.WorkflowID,
	)
}
