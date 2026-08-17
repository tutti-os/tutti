package conformance

import (
	"context"
	"errors"
	"fmt"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func runCreateWithAuthoritativeRailPlacement(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, Fixture{}); err != nil {
		return err
	}
	input := agenthost.CreateSessionInput{
		AgentSessionID:             "session-authoritative-rail-placement",
		AgentTargetID:              "target-1",
		Provider:                   "codex",
		InitialContent:             []agenthost.PromptContentBlock{{Type: "text", Text: "build in caller-selected project"}},
		ClientSubmitID:             "create-authoritative-rail-placement-1",
		RailPlacementAuthoritative: true,
		RailPlacement: &agenthost.RailPlacement{
			Version:     1,
			Kind:        agenthost.RailPlacementKindProject,
			ProjectPath: "/workspace/caller-project",
		},
	}
	session, turnID, err := driver.Create(ctx, "workspace-1", input)
	if err != nil {
		return fmt.Errorf("create with authoritative rail placement: %w", err)
	}
	if turnID == "" {
		return errors.New("create with authoritative rail placement turn is empty")
	}
	wantKey := storesqlite.RailSectionKeyForProject("/workspace/caller-project")
	if session.RailSectionKey != wantKey {
		return fmt.Errorf(
			"create with authoritative rail placement key=%q, want %q",
			session.RailSectionKey,
			wantKey,
		)
	}
	metrics := driver.Metrics()
	if err := requireRuntimeRailPlacement(metrics.LastStartEnv, agenthost.RailPlacement{
		Version: 1, Kind: agenthost.RailPlacementKindProject,
		ProjectPath: "/workspace/caller-project", SectionKey: wantKey,
	}); err != nil {
		return fmt.Errorf("create authoritative runtime: %w", err)
	}
	if err := verifyRetriedInitialCreate(ctx, driver, input, session, turnID); err != nil {
		return err
	}
	conflictingRetry := input
	conflictingPlacement := *input.RailPlacement
	conflictingPlacement.ProjectPath = "/workspace/other-caller-project"
	conflictingRetry.RailPlacement = &conflictingPlacement
	if _, _, err := driver.Create(ctx, "workspace-1", conflictingRetry); !errors.Is(
		err,
		agenthost.ErrRailPlacementConflict,
	) {
		return fmt.Errorf("authoritative retry with conflicting rail placement error=%v", err)
	}
	return nil
}
