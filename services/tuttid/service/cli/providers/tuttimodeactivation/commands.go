package tuttimodeactivation

import (
	"context"
	"errors"
	"fmt"
	"strings"

	activationbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeactivation"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
	tuttimodeactivationservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeactivation"
)

type modeSetInput struct {
	State string `cli:"state" validate:"required" enum:"active,inactive" description:"Target Tutti Mode activation state for the calling Agent session: active enables Tutti Mode, inactive disables it."`
}

func (p Provider) newModeSetCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[modeSetInput]{
		ID:          appID + ".mode.set",
		Path:        []string{"mode", "set"},
		Summary:     "Set Tutti Mode for the calling session",
		Description: "Enable or disable the durable Tutti Mode activation for the invoking Agent session. Effect and speed preferences are preserved; the change is reflected live in the session's Tutti Mode toggle.",
		Kind:        framework.KindAction,
		Visibility:  cliservice.CapabilityVisibilityPublic,
		Workspace:   framework.WorkspaceRequired,
		Inputs:      framework.FromStruct[modeSetInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewSummary: func(result any) map[string]any {
					return result.(map[string]any)
				},
			},
		},
		Run: p.runModeSet,
	})
}

func (p Provider) runModeSet(
	ctx context.Context,
	invoke framework.InvokeContext,
	input modeSetInput,
) (any, error) {
	if err := p.requireActivations(); err != nil {
		return nil, err
	}
	sessionID := strings.TrimSpace(invoke.Request.Context.AgentSessionID)
	if sessionID == "" {
		return nil, cliservice.MissingRequiredInputError("agent-session-id")
	}
	state := activationbiz.State(strings.TrimSpace(input.State))
	if !activationbiz.IsState(state) {
		return nil, cliservice.InvalidInputKeyError("state")
	}
	result, err := p.activations.Set(ctx, tuttimodeactivationservice.SetInput{
		WorkspaceID:    invoke.WorkspaceID,
		AgentSessionID: sessionID,
		State:          state,
		Source:         activationbiz.SourceAgentCommand,
	})
	if err != nil {
		return nil, modeSetError(err)
	}
	response := map[string]any{
		"state":   string(state),
		"changed": result.Changed,
	}
	if result.Activation != nil {
		response["activationId"] = result.Activation.ID
		response["revision"] = result.Activation.CurrentRevision.Revision
		response["state"] = string(result.Activation.CurrentRevision.State)
	}
	return response, nil
}

func modeSetError(err error) error {
	switch {
	case errors.Is(err, tuttimodeactivationservice.ErrServiceUnavailable):
		return cliservice.ServiceUnavailableError("Tutti Mode activation service is unavailable", err)
	case errors.Is(err, tuttimodeactivationservice.ErrRevisionConflict):
		return fmt.Errorf("%w: Tutti Mode activation changed concurrently; retry", cliservice.ErrInvalidInput)
	case errors.Is(err, tuttimodeactivationservice.ErrInvalidInput):
		return fmt.Errorf("%w: %s", cliservice.ErrInvalidInput, err.Error())
	default:
		return err
	}
}
