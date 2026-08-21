package conformance

import (
	"context"
	"fmt"
	"reflect"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

type RuntimeConfigurationRebindDriver interface {
	Reset(context.Context, Fixture) error
	RebindAndSend(context.Context, agenthost.SessionRef, agenthost.ReprepareRuntimeSessionInput, agenthost.SendInput) (SendObservation, error)
	CanonicalRuntimeContext(context.Context, agenthost.SessionRef) (map[string]any, error)
}

type RuntimeConfigurationRebindScenario struct {
	Name string
	run  func(context.Context, RuntimeConfigurationRebindDriver) error
}

func RuntimeConfigurationRebindScenarios() []RuntimeConfigurationRebindScenario {
	return []RuntimeConfigurationRebindScenario{{
		Name: "runtime replacement commits configuration before turn admission",
		run:  runRuntimeReplacementCommitsConfigurationBeforeTurnAdmission,
	}}
}

func RunRuntimeConfigurationRebind(ctx context.Context, driver RuntimeConfigurationRebindDriver, scenario RuntimeConfigurationRebindScenario) error {
	if driver == nil || scenario.run == nil {
		return fmt.Errorf("runtime configuration rebind conformance driver and scenario are required")
	}
	return scenario.run(ctx, driver)
}

func runRuntimeReplacementCommitsConfigurationBeforeTurnAdmission(ctx context.Context, driver RuntimeConfigurationRebindDriver) error {
	expected := map[string]any{"connectionRevision": float64(1), "tuttiInitialTitleEstablished": false}
	replacement := map[string]any{"connectionRevision": float64(2), "tuttiInitialTitleEstablished": false}
	ref := agenthost.SessionRef{WorkspaceID: "workspace-rebind", AgentSessionID: "session-rebind"}
	if err := driver.Reset(ctx, Fixture{Session: &SessionSeed{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
		Provider: "codex", ProviderSessionID: "provider-rebind", Cwd: "/workspace",
		RuntimeContext: expected,
	}}); err != nil {
		return err
	}
	result, err := driver.RebindAndSend(ctx, ref, agenthost.ReprepareRuntimeSessionInput{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
		ExpectedRuntimeContext: expected, ReplacementRuntimeContext: replacement,
	}, agenthost.SendInput{Content: []agenthost.PromptContentBlock{{Type: "text", Text: "continue"}}, ClientSubmitID: "submit-rebind"})
	if err != nil {
		return err
	}
	if result.TurnID == "" {
		return fmt.Errorf("rebind did not admit a canonical turn")
	}
	got, err := driver.CanonicalRuntimeContext(ctx, ref)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(got, replacement) {
		return fmt.Errorf("canonical runtime context = %#v, want %#v", got, replacement)
	}
	return nil
}
