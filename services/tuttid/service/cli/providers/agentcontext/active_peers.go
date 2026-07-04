package agentcontext

import (
	"context"
	"strings"

	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
)

func (p Provider) newActivePeersCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[struct{}]{
		ID:          appID + ".agent.active-peers",
		Path:        []string{"agent", "active-peers"},
		Summary:     "Show active peer agents",
		Description: "Show logical active peer agents and their execution cwd in the current workspace before editing files.",
		Kind:        framework.KindList,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[struct{}](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews:   map[framework.OutputView]func(any) map[string]any{framework.ViewSummary: activePeersValue},
			ListCompact: true,
		},
		Run: p.runActivePeers,
	})
}

func (p Provider) runActivePeers(ctx context.Context, invoke framework.InvokeContext, _ struct{}) (any, error) {
	if err := p.requireSessions(); err != nil {
		return nil, err
	}
	return p.sessions.ListActivePeers(ctx, invoke.WorkspaceID)
}

func activePeersValue(result any) map[string]any {
	peers := result.(agentservice.ActivePeers)
	return map[string]any{
		"agents":         activePeerValues(peers.Agents),
		"selfKnown":      peers.SelfKnown,
		"mayIncludeSelf": peers.MayIncludeSelf,
		"warning":        peers.Warning,
	}
}

func activePeerValues(peers []agentservice.ActivePeer) []any {
	values := make([]any, 0, len(peers))
	for _, peer := range peers {
		value := map[string]any{
			"agentSessionId": peer.Session.ID,
			"provider":       peer.Session.Provider,
			"cwd":            strings.TrimSpace(peer.Session.Cwd),
			"status":         string(peer.Session.Status),
			"title":          "",
		}
		if peer.Session.Title != nil {
			value["title"] = *peer.Session.Title
		}
		value["selfRelation"] = peer.SelfRelation
		values = append(values, value)
	}
	return values
}
