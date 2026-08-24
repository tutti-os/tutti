package agentruntime

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

const (
	cursorACPQuestionMCPServerName = "tutti-interaction"
	cursorACPQuestionMCPToolName   = "AskUserQuestion"
	cursorACPQuestionMCPPath       = "/mcp/cursor-interaction"
	cursorACPQuestionMCPVersion    = "2025-06-18"
	cursorACPQuestionMCPMaxBody    = 1 << 20
)

type cursorACPQuestionMCPActiveTurn struct {
	generation uint64
	session    Session
	turnID     string
	emit       EventSink
}

// cursorACPQuestionMCPBridge supplies the AskUserQuestion capability that the
// Cursor CLI exposes on its interactive CLI surface but currently omits from
// its ACP tool catalog. It uses Cursor's supported session-scoped HTTP MCP
// extension rather than patching or impersonating the provider binary.
type cursorACPQuestionMCPBridge struct {
	adapter *standardACPAdapter

	mu            sync.Mutex
	listener      net.Listener
	server        *http.Server
	baseURL       string
	authorities   map[string]Session
	activeTurns   map[string]cursorACPQuestionMCPActiveTurn
	nextTurnEpoch uint64
}

func newCursorACPQuestionMCPBridge(adapter *standardACPAdapter) *cursorACPQuestionMCPBridge {
	return &cursorACPQuestionMCPBridge{
		adapter:     adapter,
		authorities: make(map[string]Session),
		activeTurns: make(map[string]cursorACPQuestionMCPActiveTurn),
	}
}

func (bridge *cursorACPQuestionMCPBridge) Bind(_ context.Context, session Session) (MCPServerBinding, func(), error) {
	if bridge == nil || bridge.adapter == nil || strings.TrimSpace(session.AgentSessionID) == "" {
		return MCPServerBinding{}, nil, errors.New("cursor interaction MCP binding identity is required")
	}
	token, err := cursorACPQuestionMCPToken(32)
	if err != nil {
		return MCPServerBinding{}, nil, err
	}
	bridge.mu.Lock()
	if err := bridge.startLocked(); err != nil {
		bridge.mu.Unlock()
		return MCPServerBinding{}, nil, err
	}
	bridge.authorities[token] = session
	baseURL := bridge.baseURL
	bridge.mu.Unlock()

	var once sync.Once
	release := func() { once.Do(func() { bridge.releaseToken(token) }) }
	return MCPServerBinding{
		Name: cursorACPQuestionMCPServerName,
		Type: "http",
		URL:  baseURL,
		Headers: map[string]string{
			"Authorization": "Bearer " + token,
		},
	}, release, nil
}

func (bridge *cursorACPQuestionMCPBridge) startLocked() error {
	if bridge.server != nil && bridge.listener != nil {
		return nil
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen for Cursor interaction MCP: %w", err)
	}
	server := &http.Server{Handler: bridge, ReadHeaderTimeout: 5 * time.Second}
	bridge.listener = listener
	bridge.server = server
	bridge.baseURL = "http://" + listener.Addr().String() + cursorACPQuestionMCPPath
	go func() { _ = server.Serve(listener) }()
	return nil
}

func (bridge *cursorACPQuestionMCPBridge) releaseToken(token string) {
	if bridge == nil || token == "" {
		return
	}
	bridge.mu.Lock()
	delete(bridge.authorities, token)
	if len(bridge.authorities) != 0 {
		bridge.mu.Unlock()
		return
	}
	server := bridge.server
	bridge.listener = nil
	bridge.server = nil
	bridge.baseURL = ""
	bridge.activeTurns = make(map[string]cursorACPQuestionMCPActiveTurn)
	bridge.mu.Unlock()
	if server != nil {
		_ = server.Close()
	}
}

func (bridge *cursorACPQuestionMCPBridge) ActivateTurn(session Session, turnID string, emit EventSink) func() {
	if bridge == nil || strings.TrimSpace(session.AgentSessionID) == "" || strings.TrimSpace(turnID) == "" {
		return func() {}
	}
	bridge.mu.Lock()
	bridge.nextTurnEpoch++
	active := cursorACPQuestionMCPActiveTurn{
		generation: bridge.nextTurnEpoch,
		session:    session,
		turnID:     strings.TrimSpace(turnID),
		emit:       emit,
	}
	bridge.activeTurns[session.AgentSessionID] = active
	bridge.mu.Unlock()
	return func() {
		bridge.mu.Lock()
		current, ok := bridge.activeTurns[session.AgentSessionID]
		if ok && current.generation == active.generation {
			delete(bridge.activeTurns, session.AgentSessionID)
		}
		bridge.mu.Unlock()
	}
}

func (bridge *cursorACPQuestionMCPBridge) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if bridge == nil || request.URL.Path != cursorACPQuestionMCPPath || !cursorACPQuestionMCPLoopbackHost(request.Host) {
		http.NotFound(writer, request)
		return
	}
	if !cursorACPQuestionMCPLoopbackOrigin(request.Header.Get("Origin")) {
		cursorACPQuestionMCPWriteError(writer, http.StatusForbidden, nil, -32020, "Origin is not allowed")
		return
	}
	if request.Method != http.MethodPost {
		writer.Header().Set("Allow", http.MethodPost)
		cursorACPQuestionMCPWriteError(writer, http.StatusMethodNotAllowed, nil, -32600, "Cursor interaction MCP only accepts POST")
		return
	}
	session, active, ok := bridge.authorize(request.Header.Get("Authorization"))
	if !ok {
		writer.Header().Set("WWW-Authenticate", "Bearer")
		cursorACPQuestionMCPWriteError(writer, http.StatusUnauthorized, nil, -32001, "Cursor interaction MCP authentication is required")
		return
	}

	decoder := json.NewDecoder(http.MaxBytesReader(writer, request.Body, cursorACPQuestionMCPMaxBody))
	decoder.DisallowUnknownFields()
	var rpc cursorACPQuestionMCPRequest
	if err := decoder.Decode(&rpc); err != nil || decoder.Decode(&struct{}{}) != io.EOF || rpc.JSONRPC != "2.0" || strings.TrimSpace(rpc.Method) == "" {
		cursorACPQuestionMCPWriteError(writer, http.StatusBadRequest, cursorACPQuestionMCPNullID(rpc.ID), -32600, "Invalid MCP request")
		return
	}

	switch rpc.Method {
	case "notifications/initialized", "notifications/cancelled":
		writer.WriteHeader(http.StatusAccepted)
	case "initialize":
		cursorACPQuestionMCPWriteResult(writer, rpc.ID, map[string]any{
			"protocolVersion": cursorACPQuestionMCPVersion,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": cursorACPQuestionMCPServerName, "version": "1"},
		})
	case "ping":
		cursorACPQuestionMCPWriteResult(writer, rpc.ID, map[string]any{})
	case "resources/list":
		cursorACPQuestionMCPWriteResult(writer, rpc.ID, map[string]any{"resources": []any{}})
	case "resources/templates/list":
		cursorACPQuestionMCPWriteResult(writer, rpc.ID, map[string]any{"resourceTemplates": []any{}})
	case "tools/list":
		cursorACPQuestionMCPWriteResult(writer, rpc.ID, map[string]any{"tools": []any{cursorACPQuestionMCPTool()}})
	case "tools/call":
		if active.turnID == "" || active.session.AgentSessionID != session.AgentSessionID {
			cursorACPQuestionMCPWriteError(writer, http.StatusOK, rpc.ID, -32000, "AskUserQuestion is only available during an active Cursor turn")
			return
		}
		var params struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if json.Unmarshal(rpc.Params, &params) != nil || params.Name != cursorACPQuestionMCPToolName {
			cursorACPQuestionMCPWriteError(writer, http.StatusOK, rpc.ID, -32602, "Invalid AskUserQuestion arguments")
			return
		}
		result, err := bridge.adapter.handleCursorMCPAskQuestion(request.Context(), active.session, active.turnID, params.Arguments, active.emit)
		if err != nil {
			cursorACPQuestionMCPWriteError(writer, http.StatusOK, rpc.ID, -32000, err.Error())
			return
		}
		cursorACPQuestionMCPWriteResult(writer, rpc.ID, result)
	default:
		cursorACPQuestionMCPWriteError(writer, http.StatusOK, rpc.ID, -32601, "Method not found")
	}
}

func (bridge *cursorACPQuestionMCPBridge) authorize(header string) (Session, cursorACPQuestionMCPActiveTurn, bool) {
	token, ok := strings.CutPrefix(strings.TrimSpace(header), "Bearer ")
	if !ok || token == "" {
		return Session{}, cursorACPQuestionMCPActiveTurn{}, false
	}
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	session, exists := bridge.authorities[token]
	if !exists {
		return Session{}, cursorACPQuestionMCPActiveTurn{}, false
	}
	return session, bridge.activeTurns[session.AgentSessionID], true
}

func (a *standardACPAdapter) handleCursorMCPAskQuestion(
	ctx context.Context,
	session Session,
	turnID string,
	arguments map[string]any,
	emit EventSink,
) (map[string]any, error) {
	callID, requestID := newID(), newID()
	input := clonePayload(arguments)
	input["toolCallId"] = callID
	raw, err := json.Marshal(input)
	if err != nil {
		return nil, fmt.Errorf("encode AskUserQuestion arguments: %w", err)
	}
	parsed, normalized, err := parseCursorAskQuestionRequest(raw)
	if err != nil {
		return nil, err
	}
	normalized["requestId"] = requestID
	title := firstNonEmpty(strings.TrimSpace(parsed.Title), cursorACPQuestionMCPToolName)
	pending := &pendingACPApproval{
		agentSessionID:       strings.TrimSpace(session.AgentSessionID),
		requestID:            requestID,
		eventID:              newID(),
		callID:               callID,
		callType:             "interactive",
		turnID:               strings.TrimSpace(turnID),
		input:                clonePayload(normalized),
		kind:                 "ask-user",
		providerMethod:       cursorACPMethodAskQuestion,
		name:                 title,
		toolName:             cursorACPQuestionMCPToolName,
		response:             make(chan pendingInteractiveResponse, 1),
		interactionRequested: true,
	}
	pending.prompt = &SessionInteractivePrompt{
		Kind:      "ask-user",
		RequestID: requestID,
		ToolName:  cursorACPQuestionMCPToolName,
		Status:    "waiting_input",
		Input:     clonePayload(normalized),
		Metadata: map[string]any{
			"callType":        "interactive",
			"interactiveKind": "ask-user",
			"toolName":        cursorACPQuestionMCPToolName,
			"providerMethod":  "mcp/tools/call",
		},
	}
	a.storePendingApproval(pending)
	if a.getPendingApproval(session.AgentSessionID, turnID, requestID) != pending {
		return nil, errors.New("cursor AskUserQuestion session is no longer active")
	}
	if emit != nil {
		emit([]activityshared.Event{
			newTurnActivityEvent(session, EventTurnUpdated, turnID, SessionStatusWaiting, "", "", map[string]any{
				"phase": string(activityshared.TurnPhaseWaitingApproval), "requestId": requestID,
			}),
			newTurnActivityEventWithID(session, pending.eventID, EventCallStarted, turnID, SessionStatusWaiting, "", title, map[string]any{
				"callId": callID, "callType": "interactive", "name": title,
				"toolName": cursorACPQuestionMCPToolName, "status": "waiting_input", "input": clonePayload(normalized),
			}),
			normalizedInteractionRequestedEvent(session, turnID, pending),
		})
	}

	selection, err := pending.wait(ctx)
	if err != nil {
		pending.finish(pendingInteractiveRequestStateInterrupted)
		if emit != nil {
			events := normalizedPermissionResolvedEvents(session, turnID, pending, pendingInteractiveResponse{}, err)
			events = append(events, newTurnActivityEvent(session, EventTurnUpdated, turnID, SessionStatusWorking, "", "", map[string]any{
				"phase": string(activityshared.TurnPhaseWorking), "requestId": requestID,
			}))
			emit(events)
		}
		return nil, err
	}
	if !pending.finish(pendingInteractiveRequestStateAnswered) {
		return nil, errors.New("cursor AskUserQuestion response is no longer live")
	}
	if emit != nil {
		emit(normalizedPermissionResolvedEvents(session, turnID, pending, selection, nil))
	}
	return cursorACPQuestionMCPResult(selection), nil
}

func cursorACPQuestionMCPResult(selection pendingInteractiveResponse) map[string]any {
	outcome := normalizePermissionOptionToken(selection.action)
	payload := map[string]any{"outcome": firstNonEmpty(outcome, "answered")}
	if answers := payloadObject(selection.payload["answersByQuestionId"]); len(answers) > 0 {
		payload["outcome"] = "answered"
		payload["answersByQuestionId"] = answers
	}
	raw, _ := json.Marshal(payload)
	return map[string]any{"content": []any{map[string]any{"type": "text", "text": string(raw)}}}
}

func cursorACPQuestionMCPPermissionDecision(raw json.RawMessage) string {
	var request struct {
		ToolCall struct {
			Title string `json:"title"`
			Kind  string `json:"kind"`
		} `json:"toolCall"`
	}
	if json.Unmarshal(raw, &request) != nil || !strings.EqualFold(strings.TrimSpace(request.ToolCall.Kind), "other") {
		return ""
	}
	title := strings.TrimSpace(request.ToolCall.Title)
	plainTitle := cursorACPQuestionMCPServerName + ": " + cursorACPQuestionMCPToolName
	cursorTitle := cursorACPQuestionMCPServerName + "-" + cursorACPQuestionMCPToolName + ": " + cursorACPQuestionMCPToolName
	if strings.EqualFold(title, plainTitle) || strings.EqualFold(title, cursorTitle) {
		return "approved"
	}
	return ""
}

func cursorACPQuestionMCPTool() map[string]any {
	option := map[string]any{
		"type": "object", "additionalProperties": false,
		"properties": map[string]any{
			"id":    map[string]any{"type": "string", "minLength": 1},
			"label": map[string]any{"type": "string", "minLength": 1},
		},
		"required": []string{"id", "label"},
	}
	question := map[string]any{
		"type": "object", "additionalProperties": false,
		"properties": map[string]any{
			"id":       map[string]any{"type": "string", "minLength": 1},
			"question": map[string]any{"type": "string", "minLength": 1},
			"options":  map[string]any{"type": "array", "minItems": 2, "maxItems": 3, "items": option},
		},
		"required": []string{"id", "question", "options"},
	}
	return map[string]any{
		"name":        cursorACPQuestionMCPToolName,
		"description": "Ask the user one to three blocking questions and wait for their answers. Use this whenever user input or a choice is needed.",
		"inputSchema": map[string]any{
			"type": "object", "additionalProperties": false,
			"properties": map[string]any{
				"title":     map[string]any{"type": "string"},
				"questions": map[string]any{"type": "array", "minItems": 1, "maxItems": 3, "items": question},
			},
			"required": []string{"questions"},
		},
		"annotations": map[string]any{
			"readOnlyHint": true, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false,
		},
	}
}

type cursorACPQuestionMCPRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type cursorACPQuestionMCPResponse struct {
	JSONRPC string                     `json:"jsonrpc"`
	ID      json.RawMessage            `json:"id"`
	Result  any                        `json:"result,omitempty"`
	Error   *cursorACPQuestionMCPError `json:"error,omitempty"`
}

type cursorACPQuestionMCPError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func cursorACPQuestionMCPWriteResult(writer http.ResponseWriter, id json.RawMessage, result any) {
	cursorACPQuestionMCPWrite(writer, http.StatusOK, cursorACPQuestionMCPResponse{JSONRPC: "2.0", ID: cursorACPQuestionMCPNullID(id), Result: result})
}

func cursorACPQuestionMCPWriteError(writer http.ResponseWriter, status int, id json.RawMessage, code int, message string) {
	cursorACPQuestionMCPWrite(writer, status, cursorACPQuestionMCPResponse{
		JSONRPC: "2.0", ID: cursorACPQuestionMCPNullID(id), Error: &cursorACPQuestionMCPError{Code: code, Message: message},
	})
}

func cursorACPQuestionMCPWrite(writer http.ResponseWriter, status int, response cursorACPQuestionMCPResponse) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "private, no-store")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(response)
}

func cursorACPQuestionMCPNullID(id json.RawMessage) json.RawMessage {
	if len(id) == 0 {
		return json.RawMessage("null")
	}
	return id
}

func cursorACPQuestionMCPToken(size int) (string, error) {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("generate Cursor interaction MCP secret: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func cursorACPQuestionMCPLoopbackHost(value string) bool {
	host := value
	if parsed, _, err := net.SplitHostPort(host); err == nil {
		host = parsed
	}
	host = strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func cursorACPQuestionMCPLoopbackOrigin(value string) bool {
	origin := strings.TrimSpace(value)
	if origin == "" || origin == "null" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := strings.Trim(strings.ToLower(parsed.Hostname()), "[]")
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}
