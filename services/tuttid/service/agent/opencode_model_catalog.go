package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
)

const opencodeModelListTimeout = 8 * time.Second

var opencodeModelTokenPattern = regexp.MustCompile(`[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._:-]*`)

type OpenCodeCLIModelLister struct {
	Command string
	Args    []string
	Cwd     string
	Timeout time.Duration
	Environ func() []string
	HomeDir func() (string, error)
}

func (l OpenCodeCLIModelLister) ListModels(ctx context.Context) (AgentModelListResult, error) {
	timeout := l.Timeout
	if timeout <= 0 {
		timeout = opencodeModelListTimeout
	}
	processCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	command := strings.TrimSpace(l.Command)
	if command == "" {
		command = "opencode"
	}
	resolver := runtimecmd.Resolver{
		Environ: l.Environ,
		HomeDir: l.HomeDir,
	}
	env := resolver.Env(nil)
	command = resolver.Resolve(command, env)
	args := append([]string{}, l.Args...)
	if len(args) == 0 {
		args = []string{"models"}
	}
	cmd := exec.CommandContext(processCtx, command, args...)
	cmd.Env = env
	if cwd := strings.TrimSpace(l.Cwd); cwd != "" {
		cmd.Dir = cwd
	}
	output, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			output = append(output, exitErr.Stderr...)
		}
		return AgentModelListResult{}, fmt.Errorf("run opencode models: %w: %s", err, strings.TrimSpace(string(output)))
	}
	models := parseOpenCodeModelsOutput(output)
	if len(models) == 0 {
		return AgentModelListResult{}, fmt.Errorf("opencode models returned no provider/model entries")
	}
	return AgentModelListResult{Models: models}, nil
}

func parseOpenCodeModelsOutput(output []byte) []AgentModelOption {
	if models := parseVerboseOpenCodeModelsOutput(output); len(models) > 0 {
		return models
	}

	scanner := bufio.NewScanner(bytes.NewReader(output))
	modelsByID := map[string]AgentModelOption{}
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		for _, token := range opencodeModelTokenPattern.FindAllString(line, -1) {
			modelID := strings.TrimSpace(token)
			if modelID == "" {
				continue
			}
			modelsByID[modelID] = AgentModelOption{
				ID:          modelID,
				DisplayName: modelID,
				Description: "OpenCode model",
			}
		}
	}
	models := make([]AgentModelOption, 0, len(modelsByID))
	for _, model := range modelsByID {
		models = append(models, model)
	}
	sort.SliceStable(models, func(leftIndex, rightIndex int) bool {
		return strings.Compare(models[leftIndex].ID, models[rightIndex].ID) < 0
	})
	return models
}

func parseVerboseOpenCodeModelsOutput(output []byte) []AgentModelOption {
	lines := bytes.Split(output, []byte("\n"))
	models := make([]AgentModelOption, 0)
	for index := 0; index < len(lines); index++ {
		modelID := strings.TrimSpace(string(lines[index]))
		if !opencodeModelTokenPattern.MatchString(modelID) || index+1 >= len(lines) {
			continue
		}
		var block bytes.Buffer
		for index++; index < len(lines); index++ {
			block.Write(lines[index])
			block.WriteByte('\n')
			var metadata map[string]any
			if json.Unmarshal(block.Bytes(), &metadata) != nil {
				continue
			}
			models = append(models, normalizeVerboseOpenCodeModel(modelID, metadata))
			break
		}
	}
	if len(models) == 0 {
		return nil
	}
	sort.SliceStable(models, func(leftIndex, rightIndex int) bool {
		return strings.Compare(models[leftIndex].ID, models[rightIndex].ID) < 0
	})
	return models
}

func normalizeVerboseOpenCodeModel(modelID string, metadata map[string]any) AgentModelOption {
	name := strings.TrimSpace(stringFromAny(metadata["name"]))
	if name == "" {
		name = modelID
	}
	variants, variantsAdvertised := metadata["variants"].(map[string]any)
	reasoningEfforts := make([]AgentModelReasoningEffortOption, 0, len(variants))
	for value := range variants {
		value = strings.TrimSpace(value)
		if value != "" {
			reasoningEfforts = append(reasoningEfforts, AgentModelReasoningEffortOption{Value: value})
		}
	}
	sort.SliceStable(reasoningEfforts, func(leftIndex, rightIndex int) bool {
		return openCodeReasoningEffortOrder(reasoningEfforts[leftIndex].Value) < openCodeReasoningEffortOrder(reasoningEfforts[rightIndex].Value)
	})
	var supportsImageInput *bool
	if capabilities, ok := metadata["capabilities"].(map[string]any); ok {
		if input, ok := capabilities["input"].(map[string]any); ok {
			if image, ok := input["image"].(bool); ok {
				supportsImageInput = &image
			}
		}
	}
	return AgentModelOption{
		ID:                         modelID,
		DisplayName:                name,
		Description:                "OpenCode model",
		ReasoningEffortsAdvertised: variantsAdvertised,
		SupportedReasoningEfforts:  reasoningEfforts,
		SupportsImageInput:         supportsImageInput,
	}
}

func openCodeReasoningEffortOrder(value string) string {
	switch value {
	case "none":
		return "0"
	case "minimal":
		return "1"
	case "low":
		return "2"
	case "medium":
		return "3"
	case "high":
		return "4"
	case "max", "xhigh":
		return "5"
	default:
		return "6:" + value
	}
}

func readOpenCodeConfiguredDefaultModel() string {
	return ""
}
