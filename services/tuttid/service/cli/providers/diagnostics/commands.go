package diagnostics

import (
	"context"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
)

const appID = "diagnostics"

type Provider struct{}

func NewProvider() Provider {
	return Provider{}
}

func (Provider) AppID() string {
	return appID
}

func (Provider) Commands() []cliservice.Command {
	return []cliservice.Command{newPingCommand()}
}

func newPingCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[struct{}]{
		ID:          appID + ".doctor.ping",
		Path:        []string{"doctor", "ping"},
		Summary:     "Check CLI command routing",
		Description: "Return a simple diagnostic response from the daemon CLI registry.",
		Kind:        framework.KindGet,
		Workspace:   framework.WorkspaceOptional,
		Inputs:      framework.FromStruct[struct{}](),
		Output: framework.OutputSpec{
			DefaultMode:   cliservice.OutputModePlain,
			DefaultView:   framework.ViewDetail,
			JSON:          true,
			RawJSON:       true,
			RawJSONReason: "diagnostic ping has a fixed one-field JSON payload",
			JSONValue: func(any) map[string]any {
				return map[string]any{"status": "ok"}
			},
			PlainText: func(any) string {
				return "ok"
			},
		},
		Run: func(context.Context, framework.InvokeContext, struct{}) (any, error) {
			return "ok", nil
		},
	})
}
