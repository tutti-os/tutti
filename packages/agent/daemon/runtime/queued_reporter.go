package agentruntime

import (
	"context"
	"errors"
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

type QueuedReporter struct {
	ClientProvider func() ActivityClient
}

func (r QueuedReporter) BindGoalProvenance(ctx context.Context, input agentsessionstore.BindGoalProvenanceInput) (agentsessionstore.GoalProvenanceBinding, error) {
	if r.ClientProvider == nil {
		return agentsessionstore.GoalProvenanceBinding{}, errors.New("agent session activity client provider is nil")
	}
	client, ok := r.ClientProvider().(goalProvenanceActivityClient)
	if !ok || client == nil {
		return agentsessionstore.GoalProvenanceBinding{}, errors.New("agent session activity client does not support goal provenance")
	}
	return client.BindGoalProvenance(ctx, input)
}

func (r QueuedReporter) LookupGoalProvenance(ctx context.Context, input agentsessionstore.LookupGoalProvenanceInput) (agentsessionstore.GoalProvenanceBinding, bool, error) {
	if r.ClientProvider == nil {
		return agentsessionstore.GoalProvenanceBinding{}, false, errors.New("agent session activity client provider is nil")
	}
	client, ok := r.ClientProvider().(goalProvenanceActivityClient)
	if !ok || client == nil {
		return agentsessionstore.GoalProvenanceBinding{}, false, errors.New("agent session activity client does not support goal provenance")
	}
	return client.LookupGoalProvenance(ctx, input)
}

func (QueuedReporter) AsyncActivityReporter() {}

func (r QueuedReporter) Report(ctx context.Context, input agentsessionstore.ReportActivityInput) error {
	if len(input.TimelineItems) == 0 && len(input.StatePatches) == 0 && len(input.MessageUpdates) == 0 && len(input.SessionAudits) == 0 && len(input.GoalReconcileRequests) == 0 {
		return nil
	}
	input.Source.SessionOrigin = agentsessionstore.WorkspaceAgentSessionOriginRuntime
	if input.Connector == nil && strings.TrimSpace(input.Source.Provider) != "" {
		input.Connector = &canonical.ConnectorInfo{
			ID:      strings.TrimSpace(input.Source.Provider),
			Version: "agent-gui-runtime",
		}
	}
	if r.ClientProvider == nil {
		return errors.New("agent session activity client provider is nil")
	}
	client := r.ClientProvider()
	if client == nil {
		return errors.New("agent session activity client is nil")
	}
	reply, err := reportSessionActivity(ctx, client, input)
	if err != nil {
		return err
	}
	return validateReportActivityAccepted(input, reply)
}
