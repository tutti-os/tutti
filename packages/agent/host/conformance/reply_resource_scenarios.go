package conformance

import (
	"context"
	"errors"
	"fmt"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

var attachReplyResourceScenario = ReplyResourceScenario{
	Name: "reply resource binds once to active turn and rejects after settlement",
	run:  runAttachReplyResource,
}

func ReplyResourceScenarios() []ReplyResourceScenario {
	return []ReplyResourceScenario{attachReplyResourceScenario}
}

func runAttachReplyResource(ctx context.Context, driver ReplyResourceDriver) error {
	fixture := Fixture{
		Session: &SessionSeed{WorkspaceID: "workspace-1", AgentSessionID: "session-1", ActiveTurnID: "turn-1"},
		Turn:    &TurnSeed{TurnID: "turn-1", Phase: storesqlite.TurnPhaseRunning},
	}
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}
	input := agenthost.AttachReplyResourceInput{
		TurnID:     "turn-1",
		ResourceID: "resource-1", DedupeKey: "sha256:abc", Kind: storesqlite.ReplyResourceKindLocalFile,
		SourceRef: "sha256_abc", ContentHash: "abc", DisplayName: "chart.png", MediaType: "image/png", SizeBytes: 42,
	}
	first, err := driver.AttachReplyResource(ctx, ref, input)
	if err != nil || !first.Created || first.Resource.TurnID != "turn-1" {
		return fmt.Errorf("first reply resource attach result=%#v error=%v", first, err)
	}
	input.ResourceID = "resource-duplicate"
	duplicate, err := driver.AttachReplyResource(ctx, ref, input)
	if err != nil || duplicate.Created || duplicate.Resource.ResourceID != "resource-1" {
		return fmt.Errorf("deduplicated reply resource result=%#v error=%v", duplicate, err)
	}
	resources, err := driver.ListTurnReplyResources(ctx, ref, "turn-1")
	if err != nil || len(resources) != 1 || resources[0].ResourceID != "resource-1" {
		return fmt.Errorf("turn reply resources=%#v error=%v", resources, err)
	}

	fixture.Session.ActiveTurnID = ""
	fixture.Turn.Phase = storesqlite.TurnPhaseSettled
	fixture.Turn.Outcome = storesqlite.TurnOutcomeCompleted
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	input.ResourceID = "late"
	input.DedupeKey = "sha256:late"
	input.SourceRef = "sha256_late"
	_, err = driver.AttachReplyResource(ctx, ref, input)
	if !errors.Is(err, agenthost.ErrNoActiveTurn) {
		return fmt.Errorf("late reply resource error=%v, want %v", err, agenthost.ErrNoActiveTurn)
	}
	return nil
}
