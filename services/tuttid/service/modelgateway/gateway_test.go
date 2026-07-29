package modelgateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestGatewayConvertsResponsesRequestAndChatJSON(t *testing.T) {
	t.Parallel()

	var upstreamRequest chatRequest
	var upstreamAuthorization string
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		upstreamAuthorization = request.Header.Get("Authorization")
		if request.URL.Path != "/v1/chat/completions" {
			http.Error(writer, "unexpected path", http.StatusNotFound)
			return
		}
		if err := json.NewDecoder(request.Body).Decode(&upstreamRequest); err != nil {
			http.Error(writer, "invalid request", http.StatusBadRequest)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{
			"id":"chatcmpl-upstream",
			"object":"chat.completion",
			"created":123,
			"model":"model-a",
			"choices":[{
				"index":0,
				"message":{
					"role":"assistant",
					"content":"完成",
					"reasoning_content":"分析",
					"tool_calls":[{
						"index":0,
						"id":"call_one",
						"type":"function",
						"function":{"name":"workspace__read_file","arguments":"{\"path\":\"README.md\"}"}
					}]
				},
				"finish_reason":"tool_calls"
			}],
			"usage":{
				"prompt_tokens":10,
				"completion_tokens":5,
				"total_tokens":15,
				"prompt_tokens_details":{"cached_tokens":3},
				"completion_tokens_details":{"reasoning_tokens":2}
			}
		}`)
	}))
	defer upstream.Close()

	gateway := newTestGateway(t, Config{})
	endpoint := registerTestRoute(t, gateway, upstream.URL, "upstream-secret", "model-a", "workspace", "session")

	body := `{
		"model":"model-a",
		"instructions":"Follow instructions",
		"input":[
			{"type":"message","role":"user","content":[
				{"type":"input_text","text":"Inspect"},
				{"type":"input_image","image_url":"data:image/png;base64,AA==","detail":"high"}
			]},
			{"type":"reasoning","summary":[{"type":"summary_text","text":"prior reasoning"}],"encrypted_content":null},
			{"type":"function_call","call_id":"call_old","namespace":"workspace","name":"read_file","arguments":"{}"},
			{"type":"function_call_output","call_id":"call_old","output":"ok"}
		],
		"tools":[{
			"type":"namespace",
			"name":"workspace",
			"description":"Workspace functions",
			"tools":[{
				"type":"function",
				"name":"read_file",
				"description":"Read one file",
				"parameters":{"type":"object","properties":{"path":{"type":"string"}}},
				"strict":true
			}]
		},{
			"type":"namespace",
			"name":"archive",
			"description":"Archive functions",
			"tools":[{
				"type":"function",
				"name":"read_file",
				"description":"Read an archived file",
				"parameters":{"type":"object"},
				"strict":false
			}]
		}],
		"tool_choice":{"type":"function","namespace":"workspace","name":"read_file"},
		"parallel_tool_calls":true,
		"reasoning":{"effort":"high","summary":"auto"},
		"max_output_tokens":2048,
		"temperature":0.2,
		"top_p":0.9,
		"stream":false,
		"store":false,
		"include":["reasoning.encrypted_content"],
		"prompt_cache_key":"cache-1",
		"text":{"verbosity":"low"},
		"client_metadata":{"trace":"one"}
	}`
	response := postResponses(t, endpoint, body, nil)
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.StatusCode, readBody(t, response.Body))
	}
	if upstreamAuthorization != "Bearer upstream-secret" {
		t.Fatalf("upstream authorization = %q", upstreamAuthorization)
	}
	if upstreamRequest.Model != "model-a" || upstreamRequest.ReasoningEffort != "high" {
		t.Fatalf("upstream request = %#v", upstreamRequest)
	}
	if upstreamRequest.MaxTokens == nil || *upstreamRequest.MaxTokens != 2048 {
		t.Fatalf("max_completion_tokens = %#v", upstreamRequest.MaxTokens)
	}
	if len(upstreamRequest.Messages) != 4 {
		t.Fatalf("upstream messages = %#v", upstreamRequest.Messages)
	}
	if upstreamRequest.Messages[0]["role"] != "system" || upstreamRequest.Messages[0]["content"] != "Follow instructions" {
		t.Fatalf("system message = %#v", upstreamRequest.Messages[0])
	}
	if upstreamRequest.Messages[2]["reasoning_content"] != "prior reasoning" {
		t.Fatalf("assistant history = %#v", upstreamRequest.Messages[2])
	}
	historyToolCalls := upstreamRequest.Messages[2]["tool_calls"].([]any)
	historyFunction := historyToolCalls[0].(map[string]any)["function"].(map[string]any)
	if historyFunction["name"] != "workspace__read_file" {
		t.Fatalf("namespaced function-call history = %#v", historyFunction)
	}
	if upstreamRequest.Messages[3]["role"] != "tool" || upstreamRequest.Messages[3]["tool_call_id"] != "call_old" {
		t.Fatalf("tool output = %#v", upstreamRequest.Messages[3])
	}
	if len(upstreamRequest.Tools) != 2 {
		t.Fatalf("tools = %#v", upstreamRequest.Tools)
	}
	upstreamFunction := upstreamRequest.Tools[0]["function"].(map[string]any)
	if upstreamFunction["name"] != "workspace__read_file" {
		t.Fatalf("flattened namespaced function = %#v", upstreamFunction)
	}
	archiveFunction := upstreamRequest.Tools[1]["function"].(map[string]any)
	if archiveFunction["name"] != "archive__read_file" {
		t.Fatalf("second flattened namespaced function = %#v", archiveFunction)
	}
	upstreamChoice := upstreamRequest.ToolChoice.(map[string]any)["function"].(map[string]any)
	if upstreamChoice["name"] != "workspace__read_file" {
		t.Fatalf("flattened namespaced tool choice = %#v", upstreamRequest.ToolChoice)
	}

	var converted map[string]any
	if err := json.NewDecoder(response.Body).Decode(&converted); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if converted["object"] != "response" || converted["status"] != "completed" {
		t.Fatalf("converted response = %#v", converted)
	}
	output, ok := converted["output"].([]any)
	if !ok || len(output) != 3 {
		t.Fatalf("output = %#v", converted["output"])
	}
	if output[0].(map[string]any)["type"] != "reasoning" ||
		output[1].(map[string]any)["type"] != "message" ||
		output[2].(map[string]any)["type"] != "function_call" {
		t.Fatalf("output order = %#v", output)
	}
	if output[2].(map[string]any)["namespace"] != "workspace" {
		t.Fatalf("namespaced function call = %#v", output[2])
	}
	usage := converted["usage"].(map[string]any)
	if usage["input_tokens"] != float64(10) || usage["output_tokens"] != float64(5) {
		t.Fatalf("usage = %#v", usage)
	}
}

func TestGatewayFiltersUntranslatableToolRegistrations(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name             string
		body             string
		wantToolNames    []string
		wantToolChoice   any
		wantParallelTool *bool
	}{
		{
			name: "mixed supported and future hosted tools",
			body: `{
				"model":"model-a",
				"input":"hello",
				"tools":[
					{"type":"web_search"},
					{"type":"future_hosted_tool","preview":true},
					{"type":"function","name":"read_file","parameters":{"type":"object"}}
				],
				"tool_choice":"auto",
				"parallel_tool_calls":true
			}`,
			wantToolNames:    []string{"read_file"},
			wantToolChoice:   "auto",
			wantParallelTool: boolPointerForGatewayTest(true),
		},
		{
			name: "required choice preserved when a supported tool remains",
			body: `{
				"model":"model-a",
				"input":"hello",
				"tools":[
					{"type":"web_search"},
					{"type":"function","name":"read_file","parameters":{"type":"object"}}
				],
				"tool_choice":"required"
			}`,
			wantToolNames:  []string{"read_file"},
			wantToolChoice: "required",
		},
		{
			name: "all registrations filtered",
			body: `{
				"model":"model-a",
				"input":"hello",
				"tools":[
					{"type":"web_search"},
					{"type":"future_hosted_tool"}
				],
				"tool_choice":"auto",
				"parallel_tool_calls":true
			}`,
		},
		{
			name: "untranslatable namespace children filtered",
			body: `{
				"model":"model-a",
				"input":"hello",
				"tools":[{
					"type":"namespace",
					"name":"workspace",
					"tools":[
						{"type":"future_hosted_tool","name":"preview"},
						{"type":"function","name":"write_file","parameters":{"type":"object"}}
					]
				}]
			}`,
			wantToolNames: []string{"workspace__write_file"},
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			var upstreamRequest chatRequest
			upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				if err := json.NewDecoder(request.Body).Decode(&upstreamRequest); err != nil {
					http.Error(writer, "invalid request", http.StatusBadRequest)
					return
				}
				writer.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(writer, `{
					"id":"chat-filtered",
					"model":"model-a",
					"choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],
					"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}
				}`)
			}))
			defer upstream.Close()

			gateway := newTestGateway(t, Config{})
			endpoint := registerTestRoute(t, gateway, upstream.URL, "secret", "model-a", "workspace", "session")
			response := postResponses(t, endpoint, test.body, nil)
			defer response.Body.Close()
			if response.StatusCode != http.StatusOK {
				t.Fatalf("status = %d, body = %s", response.StatusCode, readBody(t, response.Body))
			}

			gotToolNames := make([]string, 0, len(upstreamRequest.Tools))
			for _, tool := range upstreamRequest.Tools {
				function, _ := tool["function"].(map[string]any)
				name, _ := function["name"].(string)
				gotToolNames = append(gotToolNames, name)
			}
			if fmt.Sprint(gotToolNames) != fmt.Sprint(test.wantToolNames) {
				t.Fatalf("upstream tool names = %v, want %v", gotToolNames, test.wantToolNames)
			}
			if fmt.Sprint(upstreamRequest.ToolChoice) != fmt.Sprint(test.wantToolChoice) {
				t.Fatalf("upstream tool_choice = %#v, want %#v", upstreamRequest.ToolChoice, test.wantToolChoice)
			}
			switch {
			case test.wantParallelTool == nil && upstreamRequest.ParallelToolCalls != nil:
				t.Fatalf("parallel_tool_calls = %#v, want nil", upstreamRequest.ParallelToolCalls)
			case test.wantParallelTool != nil &&
				(upstreamRequest.ParallelToolCalls == nil ||
					*upstreamRequest.ParallelToolCalls != *test.wantParallelTool):
				t.Fatalf("parallel_tool_calls = %#v, want %v", upstreamRequest.ParallelToolCalls, *test.wantParallelTool)
			}
		})
	}
}

func boolPointerForGatewayTest(value bool) *bool {
	return &value
}

func TestGatewayNormalizesCodexInternalRolesAndCollapsesSystemMessages(t *testing.T) {
	t.Parallel()

	var upstreamRequest chatRequest
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if err := json.NewDecoder(request.Body).Decode(&upstreamRequest); err != nil {
			http.Error(writer, "invalid request", http.StatusBadRequest)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{
			"id":"chat-developer-role",
			"model":"model-a",
			"choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]
		}`)
	}))
	defer upstream.Close()

	gateway := newTestGateway(t, Config{})
	endpoint := registerTestRoute(t, gateway, upstream.URL, "secret", "model-a", "workspace", "session")
	response := postResponses(t, endpoint, `{
		"model":"model-a",
		"instructions":"instruction",
		"input":[
			{"type":"message","role":"developer","content":[{"type":"input_text","text":"context"}]},
			{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]},
			{"type":"message","role":"developer","content":[
				{"type":"input_text","text":"late instruction"},
				{"type":"input_text","text":"continued"}
			]},
			{"type":"message","role":"latest_reminder","content":[{"type":"input_text","text":"reminder"}]},
			{"type":"message","role":"unknown_codex_role","content":[{"type":"input_text","text":"fallback"}]}
		]
	}`, nil)
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.StatusCode, readBody(t, response.Body))
	}
	if len(upstreamRequest.Messages) != 4 {
		t.Fatalf("messages = %#v", upstreamRequest.Messages)
	}
	for index, wantRole := range []string{"system", "user", "user", "user"} {
		if upstreamRequest.Messages[index]["role"] != wantRole {
			t.Fatalf("messages[%d].role = %#v, want %q", index, upstreamRequest.Messages[index]["role"], wantRole)
		}
	}
	if upstreamRequest.Messages[0]["content"] != "instruction\n\ncontext\n\nlate instruction\ncontinued" {
		t.Fatalf("system content = %#v", upstreamRequest.Messages[0]["content"])
	}
	if upstreamRequest.Messages[1]["content"] != "hello" ||
		upstreamRequest.Messages[2]["content"] != "reminder" ||
		upstreamRequest.Messages[3]["content"] != "fallback" {
		t.Fatalf("non-system message order = %#v", upstreamRequest.Messages)
	}
}

func TestGatewayStreamsInterleavedToolCallsReasoningAndUTF8WithoutDone(t *testing.T) {
	t.Parallel()

	largeArguments := `{"value":"` + strings.Repeat("x", 70<<10) + `"}`
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "text/event-stream")
		flusher := writer.(http.Flusher)
		events := []string{
			`{"id":"chat-1","model":"model-a","choices":[{"index":0,"delta":{"reasoning_content":"思考"}}]}`,
			`{"id":"chat-1","model":"model-a","choices":[{"index":0,"delta":{"content":"你"}}]}`,
			`{"id":"chat-1","model":"model-a","choices":[{"index":0,"delta":{"content":"好"}}]}`,
			`{"id":"chat-1","model":"model-a","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"alpha","arguments":"{\"a\":"}},{"index":1,"id":"call_b","type":"function","function":{"name":"beta","arguments":"{\"b\":"}}]}}]}`,
			`{"id":"chat-1","model":"model-a","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"2}"}},{"index":0,"function":{"arguments":"1}"}}]}}]}`,
			fmt.Sprintf(`{"id":"chat-1","model":"model-a","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":%q}}]}}]}`, largeArguments),
			`{"id":"chat-1","model":"model-a","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
			`{"id":"chat-1","model":"model-a","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150,"completion_tokens_details":{"reasoning_tokens":10}}}`,
		}
		for _, event := range events {
			_, _ = io.WriteString(writer, "data: "+event+"\n\n")
			flusher.Flush()
		}
		// Deliberately omit the Chat [DONE] marker. finish_reason is
		// authoritative and must still complete the Responses stream.
	}))
	defer upstream.Close()

	gateway := newTestGateway(t, Config{})
	endpoint := registerTestRoute(t, gateway, upstream.URL, "secret", "model-a", "workspace", "session")
	response := postResponses(t, endpoint, `{
		"model":"model-a",
		"input":"請處理",
		"tools":[
			{"type":"function","name":"alpha","parameters":{"type":"object"}},
			{"type":"function","name":"beta","parameters":{"type":"object"}}
		],
		"tool_choice":"auto",
		"parallel_tool_calls":true,
		"stream":true
	}`, nil)
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.StatusCode, readBody(t, response.Body))
	}
	events := readSSEEvents(t, response.Body)
	types := make([]string, 0, len(events))
	var completed map[string]any
	var toolDone []map[string]any
	for _, event := range events {
		types = append(types, event.Event)
		var payload map[string]any
		if err := json.Unmarshal(event.Data, &payload); err != nil {
			t.Fatalf("decode %s: %v", event.Event, err)
		}
		if event.Event == "response.output_item.done" {
			item, _ := payload["item"].(map[string]any)
			if item["type"] == "function_call" {
				toolDone = append(toolDone, item)
			}
		}
		if event.Event == "response.completed" {
			completed = payload
		}
	}
	for _, required := range []string{
		"response.created",
		"response.in_progress",
		"response.output_item.added",
		"response.content_part.added",
		"response.output_text.delta",
		"response.function_call_arguments.delta",
		"response.output_item.done",
		"response.completed",
	} {
		if !containsString(types, required) {
			t.Fatalf("missing event %q in %v", required, types)
		}
	}
	if len(toolDone) != 2 {
		t.Fatalf("tool calls = %#v", toolDone)
	}
	argumentsByName := map[string]string{}
	for _, item := range toolDone {
		argumentsByName[item["name"].(string)] = item["arguments"].(string)
	}
	if argumentsByName["beta"] != `{"b":2}` {
		t.Fatalf("beta arguments = %q", argumentsByName["beta"])
	}
	if !strings.Contains(argumentsByName["alpha"], largeArguments) {
		t.Fatalf("alpha arguments length = %d, want >64KB payload", len(argumentsByName["alpha"]))
	}
	if completed == nil {
		t.Fatal("response.completed missing")
	}
	responseObject := completed["response"].(map[string]any)
	if responseObject["status"] != "completed" {
		t.Fatalf("completed response = %#v", responseObject)
	}
}

func TestGatewayRouteIsolationReplacementAndCleanup(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	upstreamHits := map[string]int{}
	newUpstream := func(name string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			mu.Lock()
			upstreamHits[name]++
			mu.Unlock()
			writer.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(writer, `{"id":"chat","model":"model-a","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}`)
		}))
	}
	upstreamA := newUpstream("a")
	defer upstreamA.Close()
	upstreamB := newUpstream("b")
	defer upstreamB.Close()

	gateway := newTestGateway(t, Config{})
	first := registerTestRoute(t, gateway, upstreamA.URL, "secret-a", "model-a", "workspace-a", "session")
	second := registerTestRoute(t, gateway, upstreamB.URL, "secret-b", "model-a", "workspace-b", "session")
	replacement := registerTestRoute(t, gateway, upstreamB.URL, "secret-c", "model-a", "workspace-a", "session")

	assertGatewayStatus(t, first, http.StatusUnauthorized)
	assertGatewayStatus(t, second, http.StatusOK)
	assertGatewayStatus(t, replacement, http.StatusOK)
	gateway.Unregister(context.Background(), "workspace-a", "session")
	assertGatewayStatus(t, replacement, http.StatusUnauthorized)
	assertGatewayStatus(t, second, http.StatusOK)

	mu.Lock()
	defer mu.Unlock()
	if upstreamHits["a"] != 0 || upstreamHits["b"] != 3 {
		t.Fatalf("upstream hits = %#v", upstreamHits)
	}
}

func TestGatewayRejectsUnsupportedResponsesInputs(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("upstream must not be called")
	}))
	defer upstream.Close()
	gateway := newTestGateway(t, Config{})
	endpoint := registerTestRoute(t, gateway, upstream.URL, "secret", "model-a", "workspace", "session")

	tests := []struct {
		name  string
		body  string
		param string
	}{
		{
			name:  "explicit hosted tool choice",
			body:  `{"model":"model-a","input":"x","tools":[{"type":"web_search"}],"tool_choice":{"type":"web_search"}}`,
			param: "tool_choice",
		},
		{
			name:  "required choice after all registrations filtered",
			body:  `{"model":"model-a","input":"x","tools":[{"type":"future_hosted_tool"}],"tool_choice":"required"}`,
			param: "tool_choice",
		},
		{
			name:  "unregistered named function choice",
			body:  `{"model":"model-a","input":"x","tools":[{"type":"function","name":"alpha"}],"tool_choice":{"type":"function","name":"beta"}}`,
			param: "tool_choice",
		},
		{
			name:  "hosted tool call history",
			body:  `{"model":"model-a","input":[{"type":"web_search_call","id":"search_1"}]}`,
			param: "input[0].type",
		},
		{
			name:  "previous response",
			body:  `{"model":"model-a","input":"x","previous_response_id":"resp_old"}`,
			param: "previous_response_id",
		},
		{
			name:  "background",
			body:  `{"model":"model-a","input":"x","background":true}`,
			param: "background",
		},
		{
			name:  "encrypted reasoning history",
			body:  `{"model":"model-a","input":[{"type":"reasoning","summary":[],"encrypted_content":"cipher"}]}`,
			param: "input[0].encrypted_content",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			response := postResponses(t, endpoint, test.body, nil)
			defer response.Body.Close()
			if response.StatusCode != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", response.StatusCode, readBody(t, response.Body))
			}
			var payload responsesErrorEnvelope
			if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
				t.Fatalf("decode error: %v", err)
			}
			if payload.Error.Param == nil || *payload.Error.Param != test.param {
				t.Fatalf("error = %#v, want param %q", payload.Error, test.param)
			}
		})
	}
}

func TestGatewayPreservesUpstreamErrorsAndRedactsCredential(t *testing.T) {
	t.Parallel()

	for _, status := range []int{http.StatusBadRequest, http.StatusUnauthorized, http.StatusTooManyRequests, http.StatusInternalServerError} {
		status := status
		t.Run(fmt.Sprintf("status_%d", status), func(t *testing.T) {
			t.Parallel()
			upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writer.Header().Set("Content-Type", "application/json")
				writer.WriteHeader(status)
				_, _ = io.WriteString(writer, `{"error":{"message":"credential upstream-secret rejected","type":"invalid_request_error","code":"upstream"}}`)
			}))
			defer upstream.Close()
			gateway := newTestGateway(t, Config{})
			endpoint := registerTestRoute(t, gateway, upstream.URL, "upstream-secret", "model-a", "workspace", fmt.Sprintf("session-%d", status))
			response := postResponses(t, endpoint, `{"model":"model-a","input":"x"}`, nil)
			defer response.Body.Close()
			body := readBody(t, response.Body)
			if response.StatusCode != status {
				t.Fatalf("status = %d, want %d", response.StatusCode, status)
			}
			if strings.Contains(body, "upstream-secret") || !strings.Contains(body, "[REDACTED]") {
				t.Fatalf("body was not redacted: %s", body)
			}
		})
	}
}

func TestGatewayFirstTokenTimeoutAndMidStreamDisconnect(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		handler http.HandlerFunc
		code    string
	}{
		{
			name: "first token timeout",
			handler: func(writer http.ResponseWriter, request *http.Request) {
				writer.Header().Set("Content-Type", "text/event-stream")
				writer.WriteHeader(http.StatusOK)
				writer.(http.Flusher).Flush()
				<-request.Context().Done()
			},
			code: "upstream_timeout",
		},
		{
			name: "mid-stream disconnect",
			handler: func(writer http.ResponseWriter, _ *http.Request) {
				writer.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(writer, `data: {"id":"chat","choices":[{"index":0,"delta":{"content":"partial"}}]}`+"\n\n")
				writer.(http.Flusher).Flush()
			},
			code: "upstream_stream_error",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			upstream := httptest.NewServer(test.handler)
			defer upstream.Close()
			gateway := newTestGateway(t, Config{FirstTokenLimit: 30 * time.Millisecond})
			endpoint := registerTestRoute(t, gateway, upstream.URL, "secret", "model-a", "workspace", test.name)
			response := postResponses(t, endpoint, `{"model":"model-a","input":"x","stream":true}`, nil)
			defer response.Body.Close()
			events := readSSEEvents(t, response.Body)
			if len(events) < 3 || events[len(events)-1].Event != "response.failed" {
				t.Fatalf("events = %#v", events)
			}
			var payload map[string]any
			if err := json.Unmarshal(events[len(events)-1].Data, &payload); err != nil {
				t.Fatalf("decode failed event: %v", err)
			}
			responseObject := payload["response"].(map[string]any)
			responseError := responseObject["error"].(map[string]any)
			if responseError["code"] != test.code {
				t.Fatalf("error = %#v", responseError)
			}
		})
	}
}

func TestGatewayPropagatesClientCancellation(t *testing.T) {
	t.Parallel()

	upstreamCanceled := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		defer close(upstreamCanceled)
		writer.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(writer, `data: {"id":"chat","choices":[{"index":0,"delta":{"content":"first"}}]}`+"\n\n")
		writer.(http.Flusher).Flush()
		<-request.Context().Done()
	}))
	defer upstream.Close()
	gateway := newTestGateway(t, Config{})
	endpoint := registerTestRoute(t, gateway, upstream.URL, "secret", "model-a", "workspace", "session")
	ctx, cancel := context.WithCancel(context.Background())
	response := postResponses(t, endpoint, `{"model":"model-a","input":"x","stream":true}`, ctx)
	decoder := newSSEDecoder(response.Body)
	for {
		event, err := decoder.Next()
		if err != nil {
			t.Fatalf("read initial stream: %v", err)
		}
		if event.Event == "response.output_text.delta" {
			break
		}
	}
	cancel()
	_ = response.Body.Close()
	select {
	case <-upstreamCanceled:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream request was not canceled")
	}
}

func TestSSEDecoderHandlesArbitraryByteBoundariesAndLargeData(t *testing.T) {
	t.Parallel()

	payload := `{"text":"中文","arguments":"` + strings.Repeat("x", 70<<10) + `"}`
	source := "event: chunk\r\ndata: " + payload + "\r\n\r\n"
	decoder := newSSEDecoder(&oneByteReader{data: []byte(source)})
	event, err := decoder.Next()
	if err != nil {
		t.Fatalf("Next() error = %v", err)
	}
	if event.Event != "chunk" || string(event.Data) != payload {
		t.Fatalf("event = %q / %d bytes", event.Event, len(event.Data))
	}
	if _, err := decoder.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("second Next() error = %v, want EOF", err)
	}
}

type oneByteReader struct {
	data []byte
}

func (r *oneByteReader) Read(buffer []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	buffer[0] = r.data[0]
	r.data = r.data[1:]
	return 1, nil
}

func newTestGateway(t *testing.T, config Config) *Gateway {
	t.Helper()
	gateway, err := New(config)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() {
		if err := gateway.Close(); err != nil {
			t.Errorf("Close() error = %v", err)
		}
	})
	return gateway
}

func registerTestRoute(
	t *testing.T,
	gateway *Gateway,
	upstreamURL string,
	upstreamKey string,
	model string,
	workspaceID string,
	sessionID string,
) ClientEndpoint {
	t.Helper()
	endpoint, err := gateway.Register(context.Background(), Route{
		WorkspaceID: workspaceID, AgentSessionID: sessionID,
		UpstreamURL: upstreamURL, UpstreamAPIKey: upstreamKey, Models: []string{model},
	})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	if endpoint.WireAPI != "responses" || len(endpoint.Token) < 43 {
		t.Fatalf("endpoint = %#v", endpoint)
	}
	return endpoint
}

func postResponses(t *testing.T, endpoint ClientEndpoint, body string, ctx context.Context) *http.Response {
	t.Helper()
	if ctx == nil {
		ctx = context.Background()
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.BaseURL+"/responses", strings.NewReader(body))
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+endpoint.Token)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("Do() error = %v", err)
	}
	return response
}

func assertGatewayStatus(t *testing.T, endpoint ClientEndpoint, expected int) {
	t.Helper()
	response := postResponses(t, endpoint, `{"model":"model-a","input":"x"}`, nil)
	defer response.Body.Close()
	if response.StatusCode != expected {
		t.Fatalf("status = %d, want %d, body = %s", response.StatusCode, expected, readBody(t, response.Body))
	}
}

func readSSEEvents(t *testing.T, reader io.Reader) []sseEvent {
	t.Helper()
	decoder := newSSEDecoder(reader)
	var events []sseEvent
	for {
		event, err := decoder.Next()
		if errors.Is(err, io.EOF) {
			return events
		}
		if err != nil {
			t.Fatalf("read SSE: %v", err)
		}
		events = append(events, event)
	}
}

func readBody(t *testing.T, reader io.Reader) string {
	t.Helper()
	body, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("ReadAll() error = %v", err)
	}
	return string(body)
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
