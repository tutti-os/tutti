package workspace

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

const (
	appFactoryMentionContextRelativePath = "context.json"
	appFactoryPackageRootRelativePath    = "package"
)

type appFactoryMentionContext struct {
	Action      string                     `json:"action"`
	Constraints []string                   `json:"constraints"`
	Metadata    appFactoryMentionMetadata  `json:"metadata"`
	Output      appFactoryMentionOutput    `json:"output"`
	Task        string                     `json:"task"`
	UserRequest string                     `json:"userRequest"`
	Workspace   appFactoryMentionWorkspace `json:"workspace"`
}

type appFactoryMentionMetadata struct {
	AppID       string                              `json:"appId"`
	Description appFactoryMentionDescriptionContext `json:"description"`
	DisplayName string                              `json:"displayName"`
	Version     string                              `json:"version"`
}

type appFactoryMentionDescriptionContext struct {
	Exact       bool   `json:"exact"`
	Instruction string `json:"instruction,omitempty"`
	Value       string `json:"value,omitempty"`
}

type appFactoryMentionOutput struct {
	PackageRoot string `json:"packageRoot"`
}

type appFactoryMentionWorkspace struct {
	FilesReadonlyByDefault bool   `json:"filesReadonlyByDefault"`
	ID                     string `json:"id"`
	Name                   string `json:"name"`
	PhysicalRoot           string `json:"physicalRoot"`
}

func (s *AppFactoryService) buildGenerationPrompt(ctx context.Context, workspace workspacebiz.Summary, job workspacebiz.AppFactoryJob) (string, error) {
	workspaceRoot, _ := s.workspaceRoot(ctx, job.WorkspaceID)
	if err := writeAppFactoryMentionContext(workspace, workspaceRoot.PhysicalRoot, job); err != nil {
		return "", err
	}

	mention := buildAppFactoryMentionMarkdown()
	userPrompt := strings.TrimSpace(job.Prompt)
	if userPrompt == "" {
		return mention, nil
	}
	return fmt.Sprintf("%s %s", mention, userPrompt), nil
}

func writeAppFactoryMentionContext(workspace workspacebiz.Summary, physicalRoot string, job workspacebiz.AppFactoryJob) error {
	contextPath := appFactoryMentionContextRelativePath
	description := appFactoryMentionDescription(job)
	payload := appFactoryMentionContext{
		Action: "create",
		Constraints: []string{
			"Do not assume hidden Tutti daemon internals, preload APIs, tokens, or desktop APIs.",
			"Validate against the App Factory skill before finishing.",
			"Ensure all buttons, toolbars, and action bars adapt to window size using CSS flexbox wrapping or responsive layout; never allow buttons to overflow outside the document area.",
			"Use max-width: 100% and overflow handling on container elements to prevent horizontal overflow at narrow viewport sizes.",
			"Default new apps to a Node server; use Python only for existing Python projects or explicit Python requests.",
			"If the app needs local agent or local LLM execution, the Tutti agent catalog, or app-owned MCP/tooling, follow the tutti-agent-workspace-app skill and use @tutti-os/agent-acp-kit instead of raw TUTTI_CLI agent commands or session polling.",
			"Agent-enabled app main flows must derive agent options from the current Tutti Agent Target catalog and references/dynamic-agent-providers.md; expose every returned agent, keep exact agent ids as selection identity, and treat provider as derived runtime metadata. Do not hard-code a fixed provider catalog.",
		},
		Metadata: appFactoryMentionMetadata{
			AppID:       strings.TrimSpace(job.AppID),
			Description: description,
			DisplayName: strings.TrimSpace(job.DisplayName),
			Version:     defaultFactoryAppVersion,
		},
		Output: appFactoryMentionOutput{
			PackageRoot: appFactoryPackageRootRelativePath,
		},
		Task:        "Create a Tutti workspace app package under the output packageRoot directory.",
		UserRequest: strings.TrimSpace(job.Prompt),
		Workspace: appFactoryMentionWorkspace{
			FilesReadonlyByDefault: true,
			ID:                     strings.TrimSpace(job.WorkspaceID),
			Name:                   strings.TrimSpace(workspace.Name),
			PhysicalRoot:           strings.TrimSpace(physicalRoot),
		},
	}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal app factory mention context: %w", err)
	}
	path := filepath.Join(job.DraftDir, filepath.FromSlash(contextPath))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create app factory mention context dir: %w", err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		return fmt.Errorf("write app factory mention context: %w", err)
	}
	return nil
}

func appFactoryMentionDescription(job workspacebiz.AppFactoryJob) appFactoryMentionDescriptionContext {
	description := strings.TrimSpace(job.Description)
	if description != "" {
		return appFactoryMentionDescriptionContext{
			Exact: true,
			Value: description,
		}
	}
	name := strings.TrimSpace(job.DisplayName)
	return appFactoryMentionDescriptionContext{
		Exact: false,
		Instruction: "Generate a concise, natural, user-facing one-sentence description based on the user request and actual app behavior. Do not use generic placeholder wording like " +
			quoteFactoryPromptContextValue(name+" workspace app.") +
			". Write the generated description in tutti.app.json instead of copying this instruction text.",
	}
}

func buildAppFactoryMentionMarkdown() string {
	return "[@Create App](mention://workspace-app-factory/create)"
}

func quoteFactoryPromptContextValue(value string) string {
	return strconv.Quote(strings.TrimSpace(value))
}

func buildFactoryFixPrompt(prompt string, failureReason string) string {
	prefix := "Fix the current Tutti workspace app draft. The current working directory is the factory job workspace. Read context.json if it is present, then update only the app package under package/. Keep the generated appId unchanged. Reread and follow the App Factory skill, update package/AGENTS.md if behavior changes, and make the package pass validation."
	if strings.TrimSpace(failureReason) != "" {
		prefix += "\n\nCurrent failure reason:\n" + strings.TrimSpace(failureReason)
	}
	return prefix + "\n\nUser request:\n" + prompt
}
