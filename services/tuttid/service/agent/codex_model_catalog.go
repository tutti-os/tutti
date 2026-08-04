package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/modelcatalog"
	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
)

const (
	codexAppServerModelListTimeout  = 8 * time.Second
	codexAppServerShutdownWaitDelay = 100 * time.Millisecond
	codexModelListMaxLineBytes      = 16 * 1024 * 1024
	codexModelListMaxStderrBytes    = 1024 * 1024
)

type CodexCLIModelLister struct {
	Command          string
	Args             []string
	ClientName       string
	Provider         string
	ProviderCommands ProviderCommandResolver
	Timeout          time.Duration
	Environ          func() []string
	PrepareEnv       func(context.Context, []string) ([]string, error)
	HomeDir          func() (string, error)
	IsExecutableFile func(string) bool
	LookPath         func(string) (string, error)
}

type ProviderCommandResolver interface {
	ResolveProviderCommand(context.Context, string) (agentstatusservice.ProviderCommandResolution, error)
}

type truncatingBuffer struct {
	max int
	buf bytes.Buffer
}

func (b *truncatingBuffer) Write(p []byte) (int, error) {
	if b.max <= 0 || b.buf.Len() >= b.max {
		return len(p), nil
	}
	remaining := b.max - b.buf.Len()
	if len(p) > remaining {
		_, _ = b.buf.Write(p[:remaining])
		return len(p), nil
	}
	_, _ = b.buf.Write(p)
	return len(p), nil
}

func (b *truncatingBuffer) String() string {
	return b.buf.String()
}

func (l CodexCLIModelLister) ListModels(ctx context.Context) (AgentModelListResult, error) {
	timeout := l.Timeout
	if timeout <= 0 {
		timeout = codexAppServerModelListTimeout
	}
	processCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	command := strings.TrimSpace(l.Command)
	if command == "" {
		command = "codex"
	}
	args := append([]string{}, l.Args...)
	resolver := runtimecmd.Resolver{
		Environ:          l.Environ,
		HomeDir:          l.HomeDir,
		IsExecutableFile: l.IsExecutableFile,
		LookPath:         l.LookPath,
	}
	var envOverrides []string
	if l.ProviderCommands != nil && strings.TrimSpace(l.Provider) != "" {
		resolution, err := l.ProviderCommands.ResolveProviderCommand(processCtx, l.Provider)
		if err != nil {
			return AgentModelListResult{}, fmt.Errorf("resolve %s model-list command: %w", l.Provider, err)
		}
		if len(resolution.Command) == 0 || strings.TrimSpace(resolution.Command[0]) == "" {
			return AgentModelListResult{}, fmt.Errorf("resolve %s model-list command: command is empty", l.Provider)
		}
		command = resolution.Command[0]
		args = append([]string{}, resolution.Command[1:]...)
		envOverrides = resolution.Env
	}
	env := resolver.Env(envOverrides)
	if l.PrepareEnv != nil {
		var err error
		env, err = l.PrepareEnv(processCtx, env)
		if err != nil {
			return AgentModelListResult{}, err
		}
	}
	command = resolver.Resolve(command, env)
	if len(args) == 0 {
		args = []string{"app-server"}
	}
	slog.Info("agent model catalog process launch",
		"event", "agent.model_catalog.process_start",
		"provider", l.Provider,
		"command", command,
		"args", args,
		"provider_command_resolver", l.ProviderCommands != nil,
	)
	process, err := startCodexAppServerProcess(processCtx, command, args, env)
	if err != nil {
		return AgentModelListResult{}, err
	}
	models, err := requestCodexModelList(process.stdin, process.stdout, l.clientName())
	processErr := processCtx.Err()
	_ = process.stop(cancel)
	if err == nil {
		return AgentModelListResult{Models: models}, nil
	}
	if processErr != nil {
		return AgentModelListResult{}, fmt.Errorf("codex app-server model/list timed out: %w", processErr)
	}
	if stderr := strings.TrimSpace(process.stderr.String()); stderr != "" {
		return AgentModelListResult{}, fmt.Errorf("%w: %s", err, stderr)
	}
	return AgentModelListResult{}, err
}

func (l CodexCLIModelLister) clientName() string {
	if name := strings.TrimSpace(l.ClientName); name != "" {
		return name
	}
	return "tuttid"
}

func requestCodexModelList(stdin io.Writer, stdout io.Reader, clientName string) ([]AgentModelOption, error) {
	encoder := json.NewEncoder(stdin)
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), codexModelListMaxLineBytes)
	if err := encoder.Encode(map[string]any{
		"id":     "1",
		"method": "initialize",
		"params": map[string]any{
			"clientInfo": map[string]string{
				"name":    clientName,
				"version": "0.1.0",
			},
		},
	}); err != nil {
		return nil, fmt.Errorf("write codex app-server initialize: %w", err)
	}
	if err := readCodexInitializeResponse(scanner); err != nil {
		return nil, err
	}
	if err := encoder.Encode(map[string]any{
		"method": "initialized",
		"params": map[string]any{},
	}); err != nil {
		return nil, fmt.Errorf("write codex app-server initialized: %w", err)
	}
	if err := encoder.Encode(map[string]any{
		"id":     "2",
		"method": "model/list",
		"params": map[string]any{
			"limit": 200,
		},
	}); err != nil {
		return nil, fmt.Errorf("write codex app-server model/list: %w", err)
	}
	return readCodexModelListResponse(scanner)
}

func readCodexInitializeResponse(scanner *bufio.Scanner) error {
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var payload map[string]json.RawMessage
		if err := json.Unmarshal([]byte(line), &payload); err != nil {
			continue
		}
		if !codexRPCIDMatches(payload["id"], "1") {
			continue
		}
		if rawError, ok := payload["error"]; ok && string(rawError) != "null" {
			return fmt.Errorf("codex app-server initialize failed: %s", extractCodexRPCError(rawError))
		}
		if rawResult, ok := payload["result"]; !ok || string(rawResult) == "null" {
			return errors.New("codex app-server initialize response missing result")
		}
		return nil
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read codex app-server stdout: %w", err)
	}
	return errors.New("codex app-server exited before initialize response")
}

func readCodexModelListResponse(scanner *bufio.Scanner) ([]AgentModelOption, error) {
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		models, handled, err := parseCodexModelListLine([]byte(line))
		if !handled {
			continue
		}
		return models, err
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read codex app-server stdout: %w", err)
	}
	return nil, errors.New("codex app-server exited before model/list response")
}

func parseCodexModelListLine(line []byte) ([]AgentModelOption, bool, error) {
	return modelcatalog.ParseCodexModelListLine(line, "2")
}

func codexRPCIDMatches(raw json.RawMessage, want string) bool {
	var stringID string
	if err := json.Unmarshal(raw, &stringID); err == nil {
		return stringID == want
	}
	var numberID int
	if err := json.Unmarshal(raw, &numberID); err == nil {
		return fmt.Sprintf("%d", numberID) == want
	}
	return false
}

func extractCodexRPCError(raw json.RawMessage) string {
	var message string
	if err := json.Unmarshal(raw, &message); err == nil && strings.TrimSpace(message) != "" {
		return strings.TrimSpace(message)
	}
	var object struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(raw, &object); err == nil && strings.TrimSpace(object.Message) != "" {
		return strings.TrimSpace(object.Message)
	}
	return "unknown codex app-server RPC error"
}
