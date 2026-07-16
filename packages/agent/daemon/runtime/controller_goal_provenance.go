package agentruntime

import (
	"context"
	"errors"
	"strings"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
)

type durableGoalProvenanceReporter interface {
	BindGoalProvenance(context.Context, agentsessionstore.BindGoalProvenanceInput) (agentsessionstore.GoalProvenanceBinding, error)
	LookupGoalProvenance(context.Context, agentsessionstore.LookupGoalProvenanceInput) (agentsessionstore.GoalProvenanceBinding, bool, error)
}

func (c *Controller) BindGoalProvenance(
	ctx context.Context,
	session Session,
	fingerprint string,
	binding GoalProvenanceBinding,
) (GoalProvenanceBinding, error) {
	reporter, ok := c.goalProvenanceReporter()
	if !ok {
		return GoalProvenanceBinding{}, errors.New("durable goal provenance reporter is unavailable")
	}
	durable, err := reporter.BindGoalProvenance(ctx, agentsessionstore.BindGoalProvenanceInput{
		WorkspaceID: session.RoomID, AgentSessionID: session.AgentSessionID,
		SessionCreatedAtUnixMS: session.CreatedAtUnixMS,
		ProviderSessionID:      session.ProviderSessionID, Fingerprint: strings.TrimSpace(fingerprint),
		OperationID: binding.OperationID, Revision: binding.Revision, RepairEpoch: binding.RepairEpoch,
		OccurredAtUnixMS: time.Now().UnixMilli(),
	})
	if err != nil {
		return GoalProvenanceBinding{}, err
	}
	return runtimeGoalProvenanceBinding(durable), nil
}

func (c *Controller) LookupGoalProvenance(
	ctx context.Context,
	session Session,
	fingerprint string,
) (GoalProvenanceBinding, bool, error) {
	reporter, ok := c.goalProvenanceReporter()
	if !ok {
		return GoalProvenanceBinding{}, false, errors.New("durable goal provenance reporter is unavailable")
	}
	durable, found, err := reporter.LookupGoalProvenance(ctx, agentsessionstore.LookupGoalProvenanceInput{
		WorkspaceID: session.RoomID, AgentSessionID: session.AgentSessionID,
		SessionCreatedAtUnixMS: session.CreatedAtUnixMS,
		ProviderSessionID:      session.ProviderSessionID, Fingerprint: strings.TrimSpace(fingerprint),
	})
	if err != nil || !found {
		return GoalProvenanceBinding{}, found, err
	}
	return runtimeGoalProvenanceBinding(durable), true, nil
}

func (c *Controller) goalProvenanceReporter() (durableGoalProvenanceReporter, bool) {
	if c == nil || c.reporter == nil {
		return nil, false
	}
	reporter, ok := c.reporter.(durableGoalProvenanceReporter)
	return reporter, ok
}

func runtimeGoalProvenanceBinding(binding agentsessionstore.GoalProvenanceBinding) GoalProvenanceBinding {
	return GoalProvenanceBinding{
		OperationID: binding.OperationID,
		Revision:    binding.Revision,
		RepairEpoch: binding.RepairEpoch,
		Ambiguous:   binding.Ambiguous,
	}
}
