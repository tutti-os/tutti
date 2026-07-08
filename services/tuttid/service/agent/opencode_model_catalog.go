package agent

import (
	"bufio"
	"bytes"
	"context"
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

func readOpenCodeConfiguredDefaultModel() string {
	return ""
}
