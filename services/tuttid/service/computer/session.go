package computer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
)

// mcpProtocolVersion is the MCP version advertised at initialize. We do NOT
// declare the `elicitation` client capability: a compliant server then never
// asks us to elicit, which is exactly the behavior that broke when codex (as
// the MCP client) advertised elicitation and forwarded the request.
const mcpProtocolVersion = "2025-06-18"

// ToolResult is the flattened result of an MCP tools/call.
type ToolResult struct {
	Text              string
	Images            []ToolImage
	StructuredContent map[string]any
	Raw               json.RawMessage
	IsError           bool
}

// ToolImage is a base64 image returned by a tool (e.g. take_screenshot).
type ToolImage struct {
	Data     string
	MimeType string
}

// ToolCatalog is the versioned native tool surface reported by cua-driver.
type ToolCatalog struct {
	SchemaVersion     string           `json:"schemaVersion"`
	CapabilityVersion string           `json:"capabilityVersion"`
	Tools             []ToolDefinition `json:"tools"`
}

// ToolDefinition preserves the MCP schema and semantic metadata needed for
// generic discovery, policy, and argument forwarding.
type ToolDefinition struct {
	Name         string          `json:"name"`
	Description  string          `json:"description"`
	InputSchema  map[string]any  `json:"inputSchema"`
	Annotations  ToolAnnotations `json:"annotations"`
	Capabilities []string        `json:"capabilities"`
	Allowed      bool            `json:"allowed"`
	DenialReason string          `json:"denialReason"`
}

// ToolAnnotations mirrors the MCP tool hints. These hints describe effects;
// Tutti-owned policy remains the authorization boundary.
type ToolAnnotations struct {
	ReadOnly    bool `json:"readOnlyHint"`
	Destructive bool `json:"destructiveHint"`
	Idempotent  bool `json:"idempotentHint"`
	OpenWorld   bool `json:"openWorldHint"`
}

// computerSession owns one cua-driver subprocess. Tool calls are serialized
// because the underlying computer is single-instance.
type computerSession struct {
	transport agentruntime.ProcessTransport
	command   func(context.Context) []string

	startMu sync.Mutex
	conn    agentruntime.ProcessConnection
	client  *mcpClient

	callMu   sync.Mutex
	inFlight int32

	idleMu sync.Mutex
	idle   *time.Timer
}

func (s *computerSession) start(ctx context.Context, cwd string) error {
	s.startMu.Lock()
	defer s.startMu.Unlock()
	if s.client != nil && !s.client.isClosed() {
		return nil
	}
	s.closeLocked()

	resolveCommand := s.command
	if resolveCommand == nil {
		resolveCommand = func(ctx context.Context) []string {
			return resolveComputerMCPCommand(ctx)
		}
	}
	command := resolveCommand(ctx)
	conn, err := s.transport.Start(ctx, agentruntime.ProcessSpec{
		Provider: "computer",
		CWD:      cwd,
		Command:  command,
		Env:      computerMCPSubprocessEnv(),
	})
	if err != nil {
		return fmt.Errorf("computer MCP failed to start: %w", err)
	}
	client := newMCPClient(conn)
	if _, err := client.call(ctx, "initialize", map[string]any{
		"protocolVersion": mcpProtocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "tuttid-computer", "version": "1"},
	}); err != nil {
		_ = conn.Close()
		return fmt.Errorf("computer MCP initialize failed: %w", err)
	}
	_ = client.notify("notifications/initialized", map[string]any{})
	s.conn = conn
	s.client = client
	return nil
}

func (s *computerSession) beginCall() {
	atomic.AddInt32(&s.inFlight, 1)
	s.idleMu.Lock()
	if s.idle != nil {
		s.idle.Stop()
	}
	s.idleMu.Unlock()
}

func (s *computerSession) endCall(scheduleIdle func()) {
	if atomic.AddInt32(&s.inFlight, -1) == 0 && scheduleIdle != nil {
		scheduleIdle()
	}
}

func (s *computerSession) inFlightCount() int32 {
	return atomic.LoadInt32(&s.inFlight)
}

func (s *computerSession) callTool(ctx context.Context, name string, args map[string]any) (ToolResult, error) {
	result, err := s.callNativeTool(ctx, name, args)
	if err != nil {
		return ToolResult{}, err
	}
	if result.IsError {
		return result, toolResultError(result)
	}
	return result, nil
}

func (s *computerSession) callNativeTool(ctx context.Context, name string, args map[string]any) (ToolResult, error) {
	if s.client == nil || s.client.isClosed() {
		return ToolResult{}, errors.New("computer session not started")
	}
	s.callMu.Lock()
	defer s.callMu.Unlock()
	if s.client == nil || s.client.isClosed() {
		return ToolResult{}, errors.New("computer session not started")
	}
	raw, err := s.client.call(ctx, "tools/call", map[string]any{"name": name, "arguments": args})
	if err != nil {
		return ToolResult{}, err
	}
	return parseToolResult(raw)
}

func (s *computerSession) listTools(ctx context.Context) (ToolCatalog, error) {
	if s.client == nil || s.client.isClosed() {
		return ToolCatalog{}, errors.New("computer session not started")
	}
	s.callMu.Lock()
	defer s.callMu.Unlock()
	if s.client == nil || s.client.isClosed() {
		return ToolCatalog{}, errors.New("computer session not started")
	}
	raw, err := s.client.call(ctx, "tools/list", map[string]any{})
	if err != nil {
		return ToolCatalog{}, err
	}
	return parseToolCatalog(raw)
}

func (s *computerSession) close() {
	s.startMu.Lock()
	defer s.startMu.Unlock()
	s.closeLocked()
}

func (s *computerSession) closeLocked() {
	if s.conn != nil {
		_ = s.conn.Close()
	}
	s.conn = nil
	s.client = nil
}

type mcpToolCallResult struct {
	IsError           bool           `json:"isError"`
	StructuredContent map[string]any `json:"structuredContent"`
	Content           []struct {
		Type     string `json:"type"`
		Text     string `json:"text"`
		Data     string `json:"data"`
		MimeType string `json:"mimeType"`
	} `json:"content"`
}

func parseToolResult(raw json.RawMessage) (ToolResult, error) {
	var parsed mcpToolCallResult
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return ToolResult{}, fmt.Errorf("decode computer tool result: %w", err)
	}
	result := ToolResult{
		IsError:           parsed.IsError,
		StructuredContent: parsed.StructuredContent,
		Raw:               append(json.RawMessage(nil), raw...),
	}
	var texts []string
	for _, item := range parsed.Content {
		switch item.Type {
		case "text":
			texts = append(texts, item.Text)
		case "image":
			result.Images = append(result.Images, ToolImage{Data: item.Data, MimeType: item.MimeType})
		}
	}
	result.Text = strings.Join(texts, "\n")
	return result, nil
}

func toolResultError(result ToolResult) error {
	message := strings.TrimSpace(result.Text)
	if message == "" {
		message = "computer tool reported an error"
	}
	return errors.New(message)
}

type mcpToolCatalog struct {
	SchemaVersion     string           `json:"schema_version"`
	CapabilityVersion string           `json:"capability_version"`
	Tools             []ToolDefinition `json:"tools"`
}

func parseToolCatalog(raw json.RawMessage) (ToolCatalog, error) {
	var parsed mcpToolCatalog
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return ToolCatalog{}, fmt.Errorf("decode computer tool catalog: %w", err)
	}
	if parsed.Tools == nil {
		parsed.Tools = []ToolDefinition{}
	}
	return ToolCatalog(parsed), nil
}
