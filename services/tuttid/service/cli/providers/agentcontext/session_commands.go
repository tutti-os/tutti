package agentcontext

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentgui"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
)

var sessionActionColumns = []cliservice.TableColumn{
	{Key: "id", Label: "ID"},
	{Key: "provider", Label: "Provider"},
	{Key: "activeTurnId", Label: "Active Turn"},
	{Key: "launchRequested", Label: "Launch Requested"},
}

type startInput struct {
	AgentID         string   `cli:"agent-id" advertise-required:"true" hint:"Use agent list --json to discover available agents."`
	Cwd             string   `cli:"cwd"`
	DisplayPrompt   string   `cli:"display-prompt"`
	Hidden          bool     `cli:"hidden"`
	Images          []string `cli:"image" description:"Image file to attach to the initial prompt. May be passed multiple times."`
	Model           string   `cli:"model"`
	PermissionMode  string   `cli:"permission-mode"`
	Prompt          string   `cli:"prompt" validate:"required"`
	Provider        string   `cli:"provider" hidden:"true"`
	ReasoningEffort string   `cli:"reasoning-effort"`
	Show            bool     `cli:"show"`
	Speed           string   `cli:"speed"`
	Title           string   `cli:"title"`
}

type sessionIDInput struct {
	SessionID string `cli:"session-id" validate:"required"`
}

type sendInput struct {
	SessionID string   `cli:"session-id" validate:"required"`
	Guidance  bool     `cli:"guidance" description:"Send this prompt as guidance to the currently active turn instead of starting a new turn."`
	Images    []string `cli:"image" description:"Image file to attach to this prompt. May be passed multiple times."`
	Prompt    string   `cli:"prompt" validate:"required"`
}

type sessionActionResult struct {
	Session          agentservice.Session
	LaunchRequested  bool
	WaitAfterVersion *uint64
}

func (p Provider) newStartCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[startInput]{
		ID:          appID + ".agent.start",
		Path:        []string{"agent", "start"},
		Summary:     "Start an agent session",
		Description: "Start an agent session by agent id. Use agent list --json to discover the currently available agents.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[startInput](),
		Output:      sessionActionOutputSpec(),
		Run: func(ctx context.Context, invoke framework.InvokeContext, input startInput) (any, error) {
			target, _, err := p.resolveAgentSelector(ctx, input.AgentID, input.Provider)
			if err != nil {
				return nil, err
			}
			return p.runStart(ctx, invoke, target, startFields{
				Cwd:             input.Cwd,
				DisplayPrompt:   input.DisplayPrompt,
				Hidden:          input.Hidden,
				Images:          input.Images,
				Model:           input.Model,
				PermissionMode:  input.PermissionMode,
				Prompt:          input.Prompt,
				ReasoningEffort: input.ReasoningEffort,
				Show:            input.Show,
				Speed:           input.Speed,
				Title:           input.Title,
			})
		},
	})
}

type startFields struct {
	Cwd             string
	DisplayPrompt   string
	Hidden          bool
	Images          []string
	Model           string
	PermissionMode  string
	Prompt          string
	ReasoningEffort string
	Show            bool
	Speed           string
	Title           string
}

func (p Provider) runStart(ctx context.Context, invoke framework.InvokeContext, target agenttargetbiz.Target, input startFields) (any, error) {
	if err := p.requireSessions(); err != nil {
		return nil, err
	}
	agentTargetID := strings.TrimSpace(target.ID)
	if agentTargetID == "" {
		return nil, fmt.Errorf("%w: agent target id is required", cliservice.ErrInvalidInput)
	}
	provider := strings.TrimSpace(target.Provider)
	cwd, err := p.resolveStartCwd(ctx, invoke.WorkspaceID, input.Cwd, invoke.Request.Context)
	if err != nil {
		return nil, err
	}
	initialContent, err := promptContentFromCLIInput(input.Prompt, input.Images)
	if err != nil {
		return nil, err
	}
	session, err := p.sessions.Create(ctx, invoke.WorkspaceID, agentservice.CreateSessionInput{
		Provider:               provider,
		AgentTargetID:          agentTargetID,
		Cwd:                    optionalStringPointer(cwd),
		InitialContent:         initialContent,
		InitialDisplayPrompt:   input.DisplayPrompt,
		Model:                  optionalStringPointer(input.Model),
		PermissionModeID:       optionalStringPointer(input.PermissionMode),
		ReasoningEffort:        optionalStringPointer(input.ReasoningEffort),
		Speed:                  optionalStringPointer(input.Speed),
		Title:                  optionalStringPointer(input.Title),
		Visible:                hiddenVisibleOverride(input.Hidden),
		ConversationDetailMode: p.composerConversationDetailMode(ctx),
	})
	if err != nil {
		return nil, err
	}
	launchRequested := false
	if input.Show {
		if err := p.publishLaunchRequested(ctx, invoke.WorkspaceID, session, "start_show", invoke.Request.Context.Source); err != nil {
			return nil, err
		}
		launchRequested = true
	}
	return sessionActionResult{Session: session, LaunchRequested: launchRequested}, nil
}

func (p Provider) composerConversationDetailMode(ctx context.Context) string {
	if p.preferences == nil {
		return ""
	}
	preferences, err := p.preferences.Get(ctx)
	if err != nil {
		return ""
	}
	return preferences.AgentConversationDetailMode
}

func hiddenVisibleOverride(hidden bool) *bool {
	if !hidden {
		return nil
	}
	visible := false
	return &visible
}

func (p Provider) resolveStartCwd(
	ctx context.Context,
	workspaceID string,
	explicit string,
	invokeContext cliservice.InvokeContext,
) (string, error) {
	if cwd := strings.TrimSpace(explicit); cwd != "" {
		return cwd, nil
	}
	callerID := strings.TrimSpace(invokeContext.AgentSessionID)
	if callerID == "" {
		return "", nil
	}
	session, err := p.sessions.Get(ctx, workspaceID, callerID)
	if err != nil {
		if errors.Is(err, agentservice.ErrSessionNotFound) {
			return "", nil
		}
		return "", err
	}
	if cwd := strings.TrimSpace(session.Cwd); cwd != "" {
		return cwd, nil
	}
	return "", nil
}

func (p Provider) newOpenCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[sessionIDInput]{
		ID:          appID + ".agent.open",
		Path:        []string{"agent", "open"},
		Summary:     "Request AgentGUI open",
		Description: "Request desktop AgentGUI activation for an existing agent session.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[sessionIDInput](),
		Output:      sessionActionOutputSpec(),
		Run:         p.runOpen,
	})
}

func (p Provider) runOpen(ctx context.Context, invoke framework.InvokeContext, input sessionIDInput) (any, error) {
	if err := p.requireSessions(); err != nil {
		return nil, err
	}
	session, err := p.sessions.Get(ctx, invoke.WorkspaceID, input.SessionID)
	if err != nil {
		return nil, err
	}
	if err := p.publishLaunchRequested(ctx, invoke.WorkspaceID, session, "open", invoke.Request.Context.Source); err != nil {
		return nil, err
	}
	return sessionActionResult{Session: session, LaunchRequested: true}, nil
}

func (p Provider) newGetCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[sessionIDInput]{
		ID:          appID + ".agent.get",
		Path:        []string{"agent", "get"},
		Summary:     "Get an agent session",
		Description: "Get compact agent session context in the current workspace.",
		Kind:        framework.KindGet,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[sessionIDInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewDetail,
			JSON:        true,
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewDetail: func(result any) map[string]any {
					return map[string]any{"session": sessionInspectValue(result.(agentservice.Session))}
				},
			},
		},
		Run: p.runGet,
	})
}

func (p Provider) runGet(ctx context.Context, invoke framework.InvokeContext, input sessionIDInput) (any, error) {
	if err := p.requireSessions(); err != nil {
		return nil, err
	}
	return p.sessions.Get(ctx, invoke.WorkspaceID, input.SessionID)
}

func (p Provider) newSendCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[sendInput]{
		ID:          appID + ".agent.send",
		Path:        []string{"agent", "send"},
		Summary:     "Send input to an agent session",
		Description: "Send user input to an existing agent session. Use --guidance to guide the currently active turn without attaching to output.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[sendInput](),
		Output:      sessionActionOutputSpec(),
		Run:         p.runSend,
	})
}

func (p Provider) runSend(ctx context.Context, invoke framework.InvokeContext, input sendInput) (any, error) {
	if err := p.requireSessions(); err != nil {
		return nil, err
	}
	content, err := promptContentFromCLIInput(input.Prompt, input.Images)
	if err != nil {
		return nil, err
	}
	messagePage, err := p.sessions.ListMessages(ctx, invoke.WorkspaceID, input.SessionID, agentservice.ListMessagesInput{
		Limit: 1,
		Order: agentactivitybiz.MessageOrderDesc,
	})
	if err != nil {
		return nil, err
	}
	waitAfterVersion := messagePage.LatestVersion
	result, err := p.sessions.SendInput(ctx, invoke.WorkspaceID, input.SessionID, agentservice.SendInput{
		Content:  content,
		Guidance: input.Guidance,
	})
	if err != nil {
		return nil, err
	}
	session := result.Session
	return sessionActionResult{Session: session, WaitAfterVersion: &waitAfterVersion}, nil
}

func promptContentFromCLIInput(prompt string, imagePaths []string) ([]agentservice.PromptContentBlock, error) {
	content := agentservice.TextPromptContent(prompt)
	for _, imagePath := range normalizeCLIImagePaths(imagePaths) {
		block, err := promptImageContentBlockFromFile(imagePath)
		if err != nil {
			return nil, err
		}
		content = append(content, block)
	}
	return content, nil
}

func normalizeCLIImagePaths(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func promptImageContentBlockFromFile(path string) (agentservice.PromptContentBlock, error) {
	mimeType := promptImageMimeTypeFromPath(path)
	if mimeType == "" {
		return agentservice.PromptContentBlock{}, fmt.Errorf("%w: invalid input %q, expected a PNG, JPEG, or WebP image", cliservice.ErrInvalidInput, "image")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return agentservice.PromptContentBlock{}, fmt.Errorf("%w: read image %q: %v", cliservice.ErrInvalidInput, path, err)
	}
	return agentservice.PromptContentBlock{
		Type:     "image",
		MimeType: mimeType,
		Data:     base64.StdEncoding.EncodeToString(data),
		Name:     filepath.Base(path),
	}, nil
}

func promptImageMimeTypeFromPath(path string) string {
	switch strings.ToLower(strings.TrimSpace(filepath.Ext(path))) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".webp":
		return "image/webp"
	default:
		return ""
	}
}

func (p Provider) newCancelCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[sessionIDInput]{
		ID:          appID + ".agent.cancel",
		Path:        []string{"agent", "cancel"},
		Summary:     "Cancel an agent session",
		Description: "Cancel an agent session in the current workspace.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[sessionIDInput](),
		Output:      sessionActionOutputSpec(),
		Run:         p.runCancel,
	})
}

func (p Provider) runCancel(ctx context.Context, invoke framework.InvokeContext, input sessionIDInput) (any, error) {
	if err := p.requireSessions(); err != nil {
		return nil, err
	}
	session, err := p.sessions.Get(ctx, invoke.WorkspaceID, input.SessionID)
	if err != nil {
		return nil, err
	}
	if turnID := strings.TrimSpace(session.ActiveTurnID); turnID != "" {
		if _, err := p.sessions.CancelTurn(ctx, invoke.WorkspaceID, input.SessionID, turnID); err != nil {
			return nil, err
		}
	}
	return sessionActionResult{Session: session}, nil
}

func sessionActionOutputSpec() framework.OutputSpec {
	return framework.OutputSpec{
		DefaultMode: cliservice.OutputModeTable,
		DefaultView: framework.ViewSummary,
		JSON:        true,
		Table: &framework.TableOutputSpec{
			Columns: sessionActionColumns,
			Rows: func(result any) []map[string]any {
				action := result.(sessionActionResult)
				return []map[string]any{{
					"id":              action.Session.ID,
					"provider":        action.Session.Provider,
					"activeTurnId":    action.Session.ActiveTurnID,
					"launchRequested": action.LaunchRequested,
				}}
			},
		},
		JSONViews: map[framework.OutputView]func(any) map[string]any{
			framework.ViewSummary: func(result any) map[string]any {
				action := result.(sessionActionResult)
				value := map[string]any{
					"launchRequested": action.LaunchRequested,
					"session":         sessionActionValue(action.Session),
				}
				if action.WaitAfterVersion != nil {
					value["waitAfterVersion"] = *action.WaitAfterVersion
				}
				return value
			},
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
		AgentTargetID:  session.AgentTargetID,
		Provider:       session.Provider,
		Source:         source,
		Reason:         reason,
	}))
}

func optionalStringPointer(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}
