package modelgateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync/atomic"
	"time"
)

type chatStreamChunk struct {
	ID      string             `json:"id"`
	Object  string             `json:"object"`
	Created int64              `json:"created"`
	Model   string             `json:"model"`
	Choices []chatStreamChoice `json:"choices"`
	Usage   *chatUsage         `json:"usage"`
	Error   json.RawMessage    `json:"error"`
}

type chatStreamChoice struct {
	Index        int             `json:"index"`
	Delta        chatStreamDelta `json:"delta"`
	FinishReason *string         `json:"finish_reason"`
}

type chatStreamDelta struct {
	Role             string          `json:"role"`
	Content          json.RawMessage `json:"content"`
	ReasoningContent json.RawMessage `json:"reasoning_content"`
	Reasoning        json.RawMessage `json:"reasoning"`
	ToolCalls        []chatToolCall  `json:"tool_calls"`
	FunctionCall     *struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	} `json:"function_call"`
}

type streamItem interface {
	outputIndex() int
	finish(*responsesSSEWriter) (map[string]any, error)
}

type reasoningStreamItem struct {
	index int
	id    string
	text  strings.Builder
}

func (i *reasoningStreamItem) outputIndex() int { return i.index }

func (i *reasoningStreamItem) finish(writer *responsesSSEWriter) (map[string]any, error) {
	part := map[string]any{"type": "reasoning_text", "text": i.text.String()}
	if err := writer.Event("response.content_part.done", map[string]any{
		"item_id": i.id, "output_index": i.index, "content_index": 0, "part": part,
	}); err != nil {
		return nil, err
	}
	item := map[string]any{
		"id":                i.id,
		"type":              "reasoning",
		"summary":           []any{},
		"content":           []any{part},
		"encrypted_content": nil,
		"status":            "completed",
	}
	if err := writer.Event("response.output_item.done", map[string]any{
		"output_index": i.index, "item": item,
	}); err != nil {
		return nil, err
	}
	return item, nil
}

type messageStreamItem struct {
	index int
	id    string
	text  strings.Builder
}

func (i *messageStreamItem) outputIndex() int { return i.index }

func (i *messageStreamItem) finish(writer *responsesSSEWriter) (map[string]any, error) {
	part := map[string]any{
		"type": "output_text", "text": i.text.String(), "annotations": []any{},
	}
	if err := writer.Event("response.output_text.done", map[string]any{
		"item_id": i.id, "output_index": i.index, "content_index": 0, "text": i.text.String(),
	}); err != nil {
		return nil, err
	}
	if err := writer.Event("response.content_part.done", map[string]any{
		"item_id": i.id, "output_index": i.index, "content_index": 0, "part": part,
	}); err != nil {
		return nil, err
	}
	item := map[string]any{
		"id": i.id, "type": "message", "role": "assistant", "status": "completed",
		"content": []any{part},
	}
	if err := writer.Event("response.output_item.done", map[string]any{
		"output_index": i.index, "item": item,
	}); err != nil {
		return nil, err
	}
	return item, nil
}

type toolStreamItem struct {
	index     int
	chatIndex int
	id        string
	callID    string
	name      string
	toolMap   responseToolMap
	arguments strings.Builder
}

func (i *toolStreamItem) outputIndex() int { return i.index }

func (i *toolStreamItem) finish(writer *responsesSSEWriter) (map[string]any, error) {
	identity := responseIdentityForChatTool(i.name, i.toolMap)
	if err := writer.Event("response.function_call_arguments.done", map[string]any{
		"item_id": i.id, "output_index": i.index, "name": identity.Name, "arguments": i.arguments.String(),
	}); err != nil {
		return nil, err
	}
	item := map[string]any{
		"id": i.id, "type": "function_call", "status": "completed",
		"call_id": i.callID, "name": identity.Name, "arguments": i.arguments.String(),
	}
	if identity.Namespace != "" {
		item["namespace"] = identity.Namespace
	}
	if err := writer.Event("response.output_item.done", map[string]any{
		"output_index": i.index, "item": item,
	}); err != nil {
		return nil, err
	}
	return item, nil
}

type chatStreamState struct {
	request      responsesRequest
	writer       *responsesSSEWriter
	responseID   string
	createdAt    int64
	model        string
	items        []streamItem
	reasoning    *reasoningStreamItem
	message      *messageStreamItem
	tools        map[int]*toolStreamItem
	usage        *chatUsage
	finishReason *string
	sawFinish    bool
	toolMap      responseToolMap
}

func newChatStreamState(
	request responsesRequest,
	writer *responsesSSEWriter,
	toolMap responseToolMap,
) *chatStreamState {
	return &chatStreamState{
		request:    request,
		writer:     writer,
		responseID: newResponseID("resp"),
		createdAt:  time.Now().Unix(),
		model:      request.Model,
		tools:      make(map[int]*toolStreamItem),
		toolMap:    toolMap,
	}
}

func (s *chatStreamState) start() error {
	response := responseObject(
		s.request, s.responseID, s.createdAt, s.model, "in_progress",
		[]any{}, nil, nil, nil,
	)
	if err := s.writer.Event("response.created", map[string]any{"response": response}); err != nil {
		return err
	}
	return s.writer.Event("response.in_progress", map[string]any{"response": response})
}

func (s *chatStreamState) process(chunk chatStreamChunk) error {
	if chunk.Created > 0 {
		s.createdAt = chunk.Created
	}
	if strings.TrimSpace(chunk.Model) != "" {
		s.model = chunk.Model
	}
	if chunk.Usage != nil {
		s.usage = chunk.Usage
	}
	if len(bytes.TrimSpace(chunk.Error)) > 0 && !bytes.Equal(bytes.TrimSpace(chunk.Error), []byte("null")) {
		return errors.New("upstream Chat stream returned an error")
	}
	for _, choice := range chunk.Choices {
		if choice.Index != 0 {
			continue
		}
		if err := s.processDelta(choice.Delta); err != nil {
			return err
		}
		if choice.FinishReason != nil {
			s.finishReason = choice.FinishReason
			s.sawFinish = true
		}
	}
	return nil
}

func (s *chatStreamState) processDelta(delta chatStreamDelta) error {
	reasoning, err := chatText(delta.ReasoningContent)
	if err != nil {
		return fmt.Errorf("decode upstream reasoning_content delta: %w", err)
	}
	if reasoning == "" {
		reasoning, err = chatText(delta.Reasoning)
		if err != nil {
			return fmt.Errorf("decode upstream reasoning delta: %w", err)
		}
	}
	if reasoning != "" {
		if err := s.addReasoning(reasoning); err != nil {
			return err
		}
	}
	text, err := chatText(delta.Content)
	if err != nil {
		return fmt.Errorf("decode upstream content delta: %w", err)
	}
	if text != "" {
		if err := s.addText(text); err != nil {
			return err
		}
	}
	for _, toolCall := range delta.ToolCalls {
		if err := s.addToolDelta(toolCall); err != nil {
			return err
		}
	}
	if delta.FunctionCall != nil {
		legacy := chatToolCall{Index: 0}
		legacy.Type = "function"
		legacy.Function.Name = delta.FunctionCall.Name
		legacy.Function.Arguments = delta.FunctionCall.Arguments
		if err := s.addToolDelta(legacy); err != nil {
			return err
		}
	}
	return nil
}

func (s *chatStreamState) nextOutputIndex() int {
	return len(s.items)
}

func (s *chatStreamState) addReasoning(delta string) error {
	if s.reasoning == nil {
		s.reasoning = &reasoningStreamItem{
			index: s.nextOutputIndex(), id: newResponseID("rs"),
		}
		s.items = append(s.items, s.reasoning)
		item := map[string]any{
			"id": s.reasoning.id, "type": "reasoning", "summary": []any{},
			"content": []any{}, "encrypted_content": nil, "status": "in_progress",
		}
		if err := s.writer.Event("response.output_item.added", map[string]any{
			"output_index": s.reasoning.index, "item": item,
		}); err != nil {
			return err
		}
		if err := s.writer.Event("response.content_part.added", map[string]any{
			"item_id": s.reasoning.id, "output_index": s.reasoning.index, "content_index": 0,
			"part": map[string]any{"type": "reasoning_text", "text": ""},
		}); err != nil {
			return err
		}
	}
	s.reasoning.text.WriteString(delta)
	return s.writer.Event("response.reasoning_text.delta", map[string]any{
		"item_id": s.reasoning.id, "output_index": s.reasoning.index, "content_index": 0,
		"delta": delta,
	})
}

func (s *chatStreamState) addText(delta string) error {
	if s.message == nil {
		s.message = &messageStreamItem{
			index: s.nextOutputIndex(), id: newResponseID("msg"),
		}
		s.items = append(s.items, s.message)
		item := map[string]any{
			"id": s.message.id, "type": "message", "role": "assistant",
			"status": "in_progress", "content": []any{},
		}
		if err := s.writer.Event("response.output_item.added", map[string]any{
			"output_index": s.message.index, "item": item,
		}); err != nil {
			return err
		}
		if err := s.writer.Event("response.content_part.added", map[string]any{
			"item_id": s.message.id, "output_index": s.message.index, "content_index": 0,
			"part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}},
		}); err != nil {
			return err
		}
	}
	s.message.text.WriteString(delta)
	return s.writer.Event("response.output_text.delta", map[string]any{
		"item_id": s.message.id, "output_index": s.message.index, "content_index": 0,
		"delta": delta,
	})
}

func (s *chatStreamState) addToolDelta(delta chatToolCall) error {
	item := s.tools[delta.Index]
	if item == nil {
		callID := strings.TrimSpace(delta.ID)
		if callID == "" {
			callID = newResponseID("call")
		}
		item = &toolStreamItem{
			index: s.nextOutputIndex(), chatIndex: delta.Index,
			id: newResponseID("fc"), callID: callID, toolMap: s.toolMap,
		}
		s.tools[delta.Index] = item
		s.items = append(s.items, item)
		added := map[string]any{
			"id": item.id, "type": "function_call", "status": "in_progress",
			"call_id": item.callID, "name": item.name, "arguments": "",
		}
		if err := s.writer.Event("response.output_item.added", map[string]any{
			"output_index": item.index, "item": added,
		}); err != nil {
			return err
		}
	}
	if strings.TrimSpace(delta.ID) != "" {
		item.callID = delta.ID
	}
	if delta.Function.Name != "" {
		item.name = mergeStreamedName(item.name, delta.Function.Name)
	}
	arguments := rawJSONString(delta.Function.Arguments)
	if arguments == "" {
		return nil
	}
	item.arguments.WriteString(arguments)
	return s.writer.Event("response.function_call_arguments.delta", map[string]any{
		"item_id": item.id, "output_index": item.index, "delta": arguments,
	})
}

func mergeStreamedName(current string, delta string) string {
	if current == "" {
		return delta
	}
	if current == delta {
		return current
	}
	if strings.HasPrefix(delta, current) {
		return delta
	}
	return current + delta
}

func (s *chatStreamState) complete() error {
	sort.SliceStable(s.items, func(left int, right int) bool {
		return s.items[left].outputIndex() < s.items[right].outputIndex()
	})
	output := make([]any, 0, len(s.items))
	for _, item := range s.items {
		completed, err := item.finish(s.writer)
		if err != nil {
			return err
		}
		output = append(output, completed)
	}
	status, incompleteDetails, responseError := responseStatus(s.finishReason)
	response := responseObject(
		s.request,
		s.responseID,
		s.createdAt,
		s.model,
		status,
		output,
		responseUsage(s.usage),
		incompleteDetails,
		responseError,
	)
	eventType := "response.completed"
	if status == "incomplete" {
		eventType = "response.incomplete"
	}
	if status == "failed" {
		eventType = "response.failed"
	}
	return s.writer.Event(eventType, map[string]any{"response": response})
}

func (s *chatStreamState) fail(code string, message string) error {
	response := responseObject(
		s.request, s.responseID, s.createdAt, s.model, "failed", []any{},
		responseUsage(s.usage), nil,
		map[string]any{"code": code, "message": message},
	)
	return s.writer.Event("response.failed", map[string]any{"response": response})
}

func (g *Gateway) convertChatStream(
	writer http.ResponseWriter,
	clientRequest *http.Request,
	request responsesRequest,
	upstream *http.Response,
	toolMap responseToolMap,
) {
	eventWriter, ok := newResponsesSSEWriter(writer)
	if !ok {
		writeResponsesError(writer, http.StatusInternalServerError, "server_error", "streaming_unsupported", "", "HTTP streaming is unavailable")
		return
	}
	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("Cache-Control", "no-cache, no-store")
	writer.Header().Set("Connection", "keep-alive")
	writer.Header().Set("X-Accel-Buffering", "no")
	state := newChatStreamState(request, eventWriter, toolMap)
	if err := state.start(); err != nil {
		return
	}
	var firstTokenTimedOut atomic.Bool
	var firstTokenSeen atomic.Bool
	timer := time.AfterFunc(g.firstTokenLimit, func() {
		if !firstTokenSeen.Load() {
			firstTokenTimedOut.Store(true)
			_ = upstream.Body.Close()
		}
	})
	defer timer.Stop()
	decoder := newSSEDecoder(upstream.Body)
	done := false
	for {
		event, err := decoder.Next()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			if clientRequest.Context().Err() != nil {
				return
			}
			if firstTokenTimedOut.Load() {
				_ = state.fail("upstream_timeout", "Timed out waiting for the first upstream token")
				return
			}
			_ = state.fail("upstream_stream_error", "Upstream Chat stream ended unexpectedly")
			return
		}
		data := bytes.TrimSpace(event.Data)
		if len(data) == 0 {
			continue
		}
		if bytes.Equal(data, []byte("[DONE]")) {
			done = true
			break
		}
		if firstTokenSeen.CompareAndSwap(false, true) {
			timer.Stop()
		}
		var chunk chatStreamChunk
		if err := json.Unmarshal(data, &chunk); err != nil {
			_ = state.fail("upstream_stream_error", "Upstream Chat stream emitted invalid JSON")
			return
		}
		if err := state.process(chunk); err != nil {
			_ = state.fail("upstream_error", "Upstream Chat stream could not be converted")
			return
		}
	}
	if !done && !state.sawFinish {
		_ = state.fail("upstream_stream_error", "Upstream Chat stream closed before a finish reason")
		return
	}
	_ = state.complete()
}

func writeSyntheticStream(
	writer http.ResponseWriter,
	request responsesRequest,
	upstream chatCompletionResponse,
	toolMap responseToolMap,
) {
	eventWriter, ok := newResponsesSSEWriter(writer)
	if !ok {
		writeResponsesError(writer, http.StatusInternalServerError, "server_error", "streaming_unsupported", "", "HTTP streaming is unavailable")
		return
	}
	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("Cache-Control", "no-cache, no-store")
	writer.Header().Set("X-Accel-Buffering", "no")
	state := newChatStreamState(request, eventWriter, toolMap)
	if strings.TrimSpace(upstream.ID) != "" && strings.HasPrefix(upstream.ID, "resp_") {
		state.responseID = upstream.ID
	}
	if upstream.Created > 0 {
		state.createdAt = upstream.Created
	}
	if upstream.Model != "" {
		state.model = upstream.Model
	}
	if err := state.start(); err != nil {
		return
	}
	if len(upstream.Choices) == 0 {
		_ = state.fail("upstream_error", "Upstream Chat response contained no choices")
		return
	}
	choice := upstream.Choices[0]
	delta := chatStreamDelta{
		Role:             choice.Message.Role,
		Content:          choice.Message.Content,
		ReasoningContent: choice.Message.ReasoningContent,
		Reasoning:        choice.Message.Reasoning,
		ToolCalls:        choice.Message.ToolCalls,
		FunctionCall:     choice.Message.FunctionCall,
	}
	if err := state.processDelta(delta); err != nil {
		_ = state.fail("upstream_error", "Upstream Chat response could not be converted")
		return
	}
	state.finishReason = choice.FinishReason
	state.sawFinish = true
	state.usage = upstream.Usage
	_ = state.complete()
}
