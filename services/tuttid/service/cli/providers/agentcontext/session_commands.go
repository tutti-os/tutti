package agentcontext

import (
	"context"
	"strings"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentgui"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

var sessionActionColumns = []cliservice.TableColumn{
	{Key: "id", Label: "ID"},
	{Key: "provider", Label: "Provider"},
	{Key: "status", Label: "Status"},
	{Key: "launchRequested", Label: "Launch Requested"},
}

func (p Provider) newStartCommand() cliservice.Command {
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          appID + ".agent.start",
			Path:        []string{"agent", "start"},
			Summary:     "Start an agent session",
			Description: "Start an agent session in the current workspace. Use --show to request AgentGUI activation.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"provider": map[string]any{"type": "string"},
					"cwd":      map[string]any{"type": "string"},
					"display-prompt": map[string]any{
						"type": "string",
					},
					"model": map[string]any{"type": "string"},
					"permission-mode": map[string]any{
						"type": "string",
					},
					"prompt": map[string]any{"type": "string"},
					"reasoning-effort": map[string]any{
						"type": "string",
					},
					"show":    map[string]any{"type": "boolean"},
					"title":   map[string]any{"type": "string"},
					"visible": map[string]any{"type": "boolean"},
				},
				"required": []string{"provider"},
			},
			Output: cliservice.CapabilityOutput{
				DefaultMode: cliservice.OutputModeTable,
				JSON:        true,
				Table:       &cliservice.TableOutput{Columns: sessionActionColumns},
			},
		},
		Handler: func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			if err := p.requireSessions(); err != nil {
				return cliservice.CommandOutput{}, err
			}
			workspaceID, err := p.workspaceID(ctx, request)
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			provider, err := cliservice.RequiredStringInput(request.Input, "provider")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			cwd, _, err := cliservice.StringInput(request.Input, "cwd")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			displayPrompt, _, err := cliservice.StringInput(request.Input, "display-prompt")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			model, _, err := cliservice.StringInput(request.Input, "model")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			permissionModeID, _, err := cliservice.StringInput(request.Input, "permission-mode")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			prompt, _, err := cliservice.StringInput(request.Input, "prompt")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			reasoningEffort, _, err := cliservice.StringInput(request.Input, "reasoning-effort")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			title, _, err := cliservice.StringInput(request.Input, "title")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			show := boolInput(request.Input, "show")
			visible := boolInput(request.Input, "visible") || show
			session, err := p.sessions.Create(ctx, workspaceID, agentservice.CreateSessionInput{
				Provider:             provider,
				Cwd:                  optionalStringPointer(cwd),
				InitialContent:       agentservice.TextPromptContent(prompt),
				InitialDisplayPrompt: displayPrompt,
				Model:                optionalStringPointer(model),
				PermissionModeID:     optionalStringPointer(permissionModeID),
				ReasoningEffort:      optionalStringPointer(reasoningEffort),
				Title:                optionalStringPointer(title),
				Visible:              boolPointer(visible),
			})
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			launchRequested := false
			if show {
				if err := p.publishLaunchRequested(ctx, workspaceID, session, "start_show", request.Context.Source); err != nil {
					return cliservice.CommandOutput{}, err
				}
				launchRequested = true
			}
			return sessionActionOutput(request, session, launchRequested), nil
		},
	}
}

func (p Provider) newOpenCommand() cliservice.Command {
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          appID + ".agent.open",
			Path:        []string{"agent", "open"},
			Summary:     "Request AgentGUI open",
			Description: "Request desktop AgentGUI activation for an existing agent session.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"session-id": map[string]any{"type": "string"},
				},
				"required": []string{"session-id"},
			},
			Output: cliservice.CapabilityOutput{
				DefaultMode: cliservice.OutputModeTable,
				JSON:        true,
				Table:       &cliservice.TableOutput{Columns: sessionActionColumns},
			},
		},
		Handler: func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			if err := p.requireSessions(); err != nil {
				return cliservice.CommandOutput{}, err
			}
			workspaceID, err := p.workspaceID(ctx, request)
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			sessionID, err := cliservice.RequiredStringInput(request.Input, "session-id")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			session, err := p.sessions.Get(ctx, workspaceID, sessionID)
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			if err := p.publishLaunchRequested(ctx, workspaceID, session, "open", request.Context.Source); err != nil {
				return cliservice.CommandOutput{}, err
			}
			return sessionActionOutput(request, session, true), nil
		},
	}
}

func (p Provider) newGetCommand() cliservice.Command {
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          appID + ".agent.get",
			Path:        []string{"agent", "get"},
			Summary:     "Get an agent session",
			Description: "Get one agent session in the current workspace.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"session-id": map[string]any{"type": "string"},
				},
				"required": []string{"session-id"},
			},
			Output: cliservice.CapabilityOutput{DefaultMode: cliservice.OutputModeJSON, JSON: true},
		},
		Handler: func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			if err := p.requireSessions(); err != nil {
				return cliservice.CommandOutput{}, err
			}
			workspaceID, err := p.workspaceID(ctx, request)
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			sessionID, err := cliservice.RequiredStringInput(request.Input, "session-id")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			session, err := p.sessions.Get(ctx, workspaceID, sessionID)
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			return cliservice.CommandOutput{Kind: cliservice.OutputModeJSON, Value: map[string]any{"session": sessionValue(session)}}, nil
		},
	}
}

func (p Provider) newSendCommand() cliservice.Command {
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          appID + ".agent.send",
			Path:        []string{"agent", "send"},
			Summary:     "Send input to an agent session",
			Description: "Send user input to an existing agent session.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"session-id": map[string]any{"type": "string"},
					"prompt":     map[string]any{"type": "string"},
				},
				"required": []string{"session-id", "prompt"},
			},
			Output: cliservice.CapabilityOutput{
				DefaultMode: cliservice.OutputModeTable,
				JSON:        true,
				Table:       &cliservice.TableOutput{Columns: sessionActionColumns},
			},
		},
		Handler: func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			if err := p.requireSessions(); err != nil {
				return cliservice.CommandOutput{}, err
			}
			workspaceID, err := p.workspaceID(ctx, request)
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			sessionID, err := cliservice.RequiredStringInput(request.Input, "session-id")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			prompt, err := cliservice.RequiredStringInput(request.Input, "prompt")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			session, err := p.sessions.SendInput(ctx, workspaceID, sessionID, agentservice.SendInput{
				Content: agentservice.TextPromptContent(prompt),
			})
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			return sessionActionOutput(request, session, false), nil
		},
	}
}

func (p Provider) newCancelCommand() cliservice.Command {
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          appID + ".agent.cancel",
			Path:        []string{"agent", "cancel"},
			Summary:     "Cancel an agent session",
			Description: "Cancel an agent session in the current workspace.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"session-id": map[string]any{"type": "string"},
				},
				"required": []string{"session-id"},
			},
			Output: cliservice.CapabilityOutput{
				DefaultMode: cliservice.OutputModeTable,
				JSON:        true,
				Table:       &cliservice.TableOutput{Columns: sessionActionColumns},
			},
		},
		Handler: func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			if err := p.requireSessions(); err != nil {
				return cliservice.CommandOutput{}, err
			}
			workspaceID, err := p.workspaceID(ctx, request)
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			sessionID, err := cliservice.RequiredStringInput(request.Input, "session-id")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			result, err := p.sessions.Cancel(ctx, workspaceID, sessionID)
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			return sessionActionOutput(request, result.Session, false), nil
		},
	}
}

func (p Provider) publishLaunchRequested(
	ctx context.Context,
	workspaceID string,
	session agentservice.Session,
	reason string,
	source string,
) error {
	if p.launchPublisher == nil {
		return nil
	}
	return p.launchPublisher.PublishAgentGUILaunchRequested(ctx, agentgui.NormalizeLaunchRequest(agentgui.LaunchRequest{
		WorkspaceID:    workspaceID,
		AgentSessionID: session.ID,
		Provider:       session.Provider,
		Source:         source,
		Reason:         reason,
	}))
}

func sessionActionOutput(
	request cliservice.InvokeRequest,
	session agentservice.Session,
	launchRequested bool,
) cliservice.CommandOutput {
	value := sessionValue(session)
	value["launchRequested"] = launchRequested
	if request.OutputMode == cliservice.OutputModeJSON {
		return cliservice.CommandOutput{Kind: cliservice.OutputModeJSON, Value: map[string]any{
			"launchRequested": launchRequested,
			"session":         value,
		}}
	}
	return cliservice.CommandOutput{
		Kind:    cliservice.OutputModeTable,
		Columns: sessionActionColumns,
		Rows: []map[string]any{{
			"id":              session.ID,
			"provider":        session.Provider,
			"status":          session.Status,
			"launchRequested": launchRequested,
		}},
	}
}

func optionalStringPointer(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func boolInput(input map[string]any, key string) bool {
	if value, ok := input[key].(bool); ok {
		return value
	}
	value, _, _ := cliservice.StringInput(input, key)
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func boolPointer(value bool) *bool {
	return &value
}
