package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/tutti-os/tutti/packages/agentactivity/daemon/runtimecmd"
)

const (
	codexAppServerModelListTimeout = 8 * time.Second
	codexModelListMaxLineBytes     = 16 * 1024 * 1024
	codexModelListMaxStderrBytes   = 1024 * 1024
)

type CodexCLIModelLister struct {
	Command          string
	Args             []string
	Timeout          time.Duration
	Environ          func() []string
	HomeDir          func() (string, error)
	IsExecutableFile func(string) bool
	LookPath         func(string) (string, error)
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
	resolver := runtimecmd.Resolver{
		Environ:          l.Environ,
		HomeDir:          l.HomeDir,
		IsExecutableFile: l.IsExecutableFile,
		LookPath:         l.LookPath,
	}
	env := resolver.Env(nil)
	command = resolver.Resolve(command, env)
	args := append([]string{}, l.Args...)
	if len(args) == 0 {
		args = []string{"app-server"}
	}
	cmd := exec.CommandContext(processCtx, command, args...)
	cmd.Env = env
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return AgentModelListResult{}, fmt.Errorf("open codex app-server stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return AgentModelListResult{}, fmt.Errorf("open codex app-server stdout: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return AgentModelListResult{}, fmt.Errorf("open codex app-server stderr: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return AgentModelListResult{}, fmt.Errorf("start codex app-server: %w", err)
	}

	stderrBuf := &truncatingBuffer{max: codexModelListMaxStderrBytes}
	var stderrWG sync.WaitGroup
	stderrWG.Add(1)
	go func() {
		defer stderrWG.Done()
		_, _ = io.Copy(stderrBuf, stderr)
	}()

	defer func() {
		_ = stdin.Close()
		cancel()
		_ = cmd.Wait()
		stderrWG.Wait()
	}()

	if err := writeCodexModelListRequests(stdin); err != nil {
		return AgentModelListResult{}, err
	}
	models, err := readCodexModelListResponse(stdout)
	if err == nil {
		return AgentModelListResult{Models: models}, nil
	}
	if processCtx.Err() != nil {
		return AgentModelListResult{}, fmt.Errorf("codex app-server model/list timed out: %w", processCtx.Err())
	}
	if stderr := strings.TrimSpace(stderrBuf.String()); stderr != "" {
		return AgentModelListResult{}, fmt.Errorf("%w: %s", err, stderr)
	}
	return AgentModelListResult{}, err
}

func writeCodexModelListRequests(stdin io.Writer) error {
	encoder := json.NewEncoder(stdin)
	if err := encoder.Encode(map[string]any{
		"id":     "1",
		"method": "initialize",
		"params": map[string]any{
			"clientInfo": map[string]string{
				"name":    "tuttid",
				"version": "0.1.0",
			},
		},
	}); err != nil {
		return fmt.Errorf("write codex app-server initialize: %w", err)
	}
	if err := encoder.Encode(map[string]any{
		"id":     "2",
		"method": "model/list",
		"params": map[string]any{
			"limit": 200,
		},
	}); err != nil {
		return fmt.Errorf("write codex app-server model/list: %w", err)
	}
	return nil
}

func readCodexModelListResponse(stdout io.Reader) ([]AgentModelOption, error) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), codexModelListMaxLineBytes)
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
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(line, &payload); err != nil {
		return nil, false, nil
	}
	if !codexRPCIDMatches(payload["id"], "2") {
		return nil, false, nil
	}
	if rawError, ok := payload["error"]; ok && string(rawError) != "null" {
		return nil, true, errors.New(extractCodexRPCError(rawError))
	}
	var result struct {
		Data []json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(payload["result"], &result); err != nil {
		return nil, true, fmt.Errorf("parse codex model/list result: %w", err)
	}
	models := make([]AgentModelOption, 0, len(result.Data))
	for _, rawModel := range result.Data {
		if model, ok := normalizeCodexModel(rawModel); ok {
			models = append(models, model)
		}
	}
	return models, true, nil
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

func normalizeCodexModel(raw json.RawMessage) (AgentModelOption, bool) {
	var object map[string]any
	if err := json.Unmarshal(raw, &object); err != nil {
		return AgentModelOption{}, false
	}
	id := stringMapValue(object, "model")
	if id == "" {
		id = stringMapValue(object, "id")
	}
	if id == "" {
		return AgentModelOption{}, false
	}
	displayName := stringMapValue(object, "displayName")
	if displayName == "" {
		displayName = stringMapValue(object, "display_name")
	}
	if displayName == "" {
		displayName = id
	}
	return AgentModelOption{
		ID:          id,
		DisplayName: displayName,
		Description: stringMapValue(object, "description"),
		IsDefault:   boolMapValue(object, "isDefault") || boolMapValue(object, "is_default"),
	}, true
}

func stringMapValue(object map[string]any, key string) string {
	value, ok := object[key].(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(value)
}

func boolMapValue(object map[string]any, key string) bool {
	value, ok := object[key].(bool)
	return ok && value
}
