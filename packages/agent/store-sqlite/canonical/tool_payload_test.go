package canonical

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestCompactToolCallPayloadKeepsBusinessProjectionWithoutProviderEnvelopes(t *testing.T) {
	payload := map[string]any{
		"source":   "runtime",
		"provider": "claude-code",
		"callId":   "call-1",
		"toolName": "Edit",
		"content": []any{
			map[string]any{"type": "tool_result", "text": "visible result"},
			map[string]any{
				"type":    "file_change",
				"paths":   []any{"/workspace/a.ts"},
				"oldText": "before",
				"newText": "after",
			},
		},
		"input": map[string]any{
			"query": "canonical",
			"rawInput": map[string]any{
				"query":   "provider",
				"command": "pwd",
			},
			"toolCall": map[string]any{
				"toolCallId": "approval-1",
				"title":      "Edit",
				"kind":       "edit",
				"input": map[string]any{
					"filePath": "/workspace/a.ts",
				},
				"rawInput": map[string]any{
					"largeProviderSnapshot": "discarded",
				},
				"content": []any{
					map[string]any{"type": "text", "text": "discarded duplicate"},
				},
				"providerDebug": true,
			},
		},
		"output": map[string]any{
			"isError": false,
			"mode":    "content",
			"structuredContent": map[string]any{
				"items": []any{"kept"},
			},
			"rawOutput": map[string]any{
				"stdout":    "command output",
				"exit_code": 0,
				"ignored":   "provider-only",
			},
			"content": []any{
				map[string]any{"type": "tool_reference", "tool_name": "Read"},
				map[string]any{
					"type": "content",
					"content": map[string]any{
						"type":     "image",
						"uri":      "/workspace/generated.png",
						"mimeType": "image/png",
					},
				},
			},
			"toolResponse": map[string]any{
				"originalFile": "large provider snapshot",
			},
		},
		"metadata": map[string]any{
			"adapter":    "claude-agent-sdk",
			"agentId":    "agent-1",
			"durationMs": 123,
			"taskStatus": "completed",
			"claudeToolResponse": map[string]any{
				"originalFile":    "large provider snapshot",
				"totalDurationMs": 999,
			},
		},
		"providerDebug": map[string]any{"raw": true},
	}

	got := CompactToolCallPayload("completed", payload)

	if _, exists := got["content"]; exists {
		t.Fatalf("payload.content retained: %#v", got)
	}
	if _, exists := got["providerDebug"]; exists {
		t.Fatalf("provider-only top-level field retained: %#v", got)
	}

	input := got["input"].(map[string]any)
	if _, exists := input["rawInput"]; exists {
		t.Fatalf("input.rawInput retained: %#v", input)
	}
	if input["query"] != "canonical" || input["command"] != "pwd" {
		t.Fatalf("input = %#v, want canonical values with flattened missing fields", input)
	}
	toolCall := input["toolCall"].(map[string]any)
	toolInput := toolCall["input"].(map[string]any)
	if toolCall["toolCallId"] != "approval-1" || toolInput["filePath"] != "/workspace/a.ts" {
		t.Fatalf("input.toolCall = %#v, want canonical approval projection", toolCall)
	}
	for _, key := range []string{"rawInput", "content", "providerDebug"} {
		if _, exists := toolCall[key]; exists {
			t.Fatalf("input.toolCall.%s retained: %#v", key, toolCall)
		}
	}

	output := got["output"].(map[string]any)
	for _, key := range []string{"content", "rawOutput", "toolResponse", "ignored"} {
		if _, exists := output[key]; exists {
			t.Fatalf("output.%s retained: %#v", key, output)
		}
	}
	if output["text"] != "visible result" || output["stdout"] != "command output" || output["exitCode"] != 0 {
		t.Fatalf("output = %#v, want normalized command result", output)
	}
	if output["isError"] != false ||
		output["mode"] != "content" ||
		!reflect.DeepEqual(output["structuredContent"], map[string]any{"items": []any{"kept"}}) {
		t.Fatalf("output = %#v, want business search and MCP fields", output)
	}
	if !reflect.DeepEqual(output["matches"], []any{"Read"}) ||
		output["totalDeferredTools"] != 1 ||
		output["savedPath"] != "/workspace/generated.png" ||
		!reflect.DeepEqual(output["savedPaths"], []any{"/workspace/generated.png"}) ||
		output["imageMimeType"] != "image/png" {
		t.Fatalf("output = %#v, want explicit tool references and generated image fields", output)
	}

	metadata := got["metadata"].(map[string]any)
	if _, exists := metadata["adapter"]; exists {
		t.Fatalf("metadata.adapter retained: %#v", metadata)
	}
	if _, exists := metadata["claudeToolResponse"]; exists {
		t.Fatalf("metadata.claudeToolResponse retained: %#v", metadata)
	}
	if metadata["taskStatus"] != "completed" || metadata["agentId"] != "agent-1" || metadata["durationMs"] != 123 {
		t.Fatalf("metadata = %#v, want business task fields", metadata)
	}

	fileChanges := got["fileChanges"].(map[string]any)
	files := fileChanges["files"].([]any)
	if len(files) != 1 {
		t.Fatalf("fileChanges = %#v, want one file", fileChanges)
	}
	file := files[0].(map[string]any)
	if file["path"] != "/workspace/a.ts" ||
		file["change"] != "modified" ||
		file["oldString"] != "before" ||
		file["newString"] != "after" {
		t.Fatalf("file change = %#v", file)
	}

	if payload["content"] == nil {
		t.Fatal("CompactToolCallPayload mutated its input")
	}
}

func TestCompactToolCallPayloadNormalizesRawCreatedBody(t *testing.T) {
	content := "# Liying\n\n- 自我介绍\n- 欢迎来到我的 README\n"
	got := CompactToolCallPayload("completed", map[string]any{
		"fileChanges": map[string]any{
			"files": []any{map[string]any{
				"path":        "/workspace/README.md",
				"change":      "created",
				"unifiedDiff": content,
			}},
		},
	})
	fileChanges, ok := got["fileChanges"].(map[string]any)
	if !ok {
		t.Fatalf("fileChanges = %#v, want canonical fileChanges", got["fileChanges"])
	}
	files, ok := fileChanges["files"].([]any)
	if !ok || len(files) != 1 {
		t.Fatalf("files = %#v, want one file", fileChanges["files"])
	}
	file, ok := files[0].(map[string]any)
	if !ok {
		t.Fatalf("file = %#v, want object", files[0])
	}
	if file["change"] != "added" || file["newString"] != content {
		t.Fatalf("file = %#v, want added file with body in newString", file)
	}
	if _, exists := file["diff"]; exists {
		t.Fatalf("file retained invalid diff: %#v", file)
	}
	if _, exists := file["unifiedDiff"]; exists {
		t.Fatalf("file retained invalid unifiedDiff: %#v", file)
	}
}

func TestCompactToolCallPayloadNormalizesNestedKindAndValidDiffAlias(t *testing.T) {
	valid := "@@ -1 +1 @@\n-old\n+new"
	got := CompactToolCallPayload("completed", map[string]any{
		"fileChanges": map[string]any{
			"files": []any{map[string]any{
				"path":        "/workspace/app.ts",
				"kind":        map[string]any{"type": "update"},
				"diff":        "README\n- bullet\n",
				"unifiedDiff": valid,
			}},
		},
	})
	files := got["fileChanges"].(map[string]any)["files"].([]any)
	file := files[0].(map[string]any)
	if file["change"] != "modified" || file["unifiedDiff"] != valid {
		t.Fatalf("file = %#v, want nested kind and valid diff alias normalized", file)
	}
}

func TestNormalizeToolFileChangesDeduplicatesAndCancelsCreatedFiles(t *testing.T) {
	got := normalizeToolFileChanges(map[string]any{
		"files": []any{
			map[string]any{"path": "/workspace/a.txt", "change": "added", "newString": "a"},
			map[string]any{"path": "/workspace/a.txt", "change": "deleted"},
			map[string]any{"path": "/workspace/b.txt", "change": "added", "newString": "b"},
		},
	})
	files := got["files"].([]any)
	if len(files) != 1 || files[0].(map[string]any)["path"] != "/workspace/b.txt" {
		t.Fatalf("normalized files = %#v, want only the surviving file", files)
	}
}

func TestCompactToolCallPayloadPreservesInvalidModifiedBodyWithoutDiff(t *testing.T) {
	body := "README\n- bullet\n"
	got := CompactToolCallPayload("completed", map[string]any{
		"fileChanges": map[string]any{
			"files": []any{map[string]any{
				"path":   "/workspace/README.md",
				"change": "modified",
				"diff":   body,
			}},
		},
	})
	file := got["fileChanges"].(map[string]any)["files"].([]any)[0].(map[string]any)
	if file["newString"] != body || file["change"] != "modified" {
		t.Fatalf("file = %#v, want invalid body preserved as newString", file)
	}
	if _, exists := file["diff"]; exists {
		t.Fatalf("file retained invalid diff: %#v", file)
	}
	if _, exists := file["content"]; exists {
		t.Fatalf("file retained obsolete content field: %#v", file)
	}
}

func TestCompactToolCallPayloadCompactsNestedTaskSteps(t *testing.T) {
	got := CompactToolCallPayload("completed", map[string]any{
		"callId":   "call-parent",
		"toolName": "Task",
		"metadata": map[string]any{
			"steps": []any{
				map[string]any{
					"id":        "step-1",
					"tool_name": "Bash",
					"status":    "completed",
					"tool_input": map[string]any{
						"rawInput": map[string]any{"command": "pwd"},
					},
					"tool_result": map[string]any{
						"rawOutput": map[string]any{
							"stdout": "nested output",
						},
						"content": []any{
							map[string]any{"type": "text", "text": "duplicate nested output"},
						},
						"toolResponse": map[string]any{
							"originalFile": "large nested snapshot",
						},
					},
				},
			},
		},
	})

	if metadata, _ := got["metadata"].(map[string]any); metadata["steps"] != nil {
		t.Fatalf("metadata.steps retained beside canonical top-level steps: %#v", metadata)
	}
	steps := got["steps"].([]any)
	if len(steps) != 1 {
		t.Fatalf("steps = %#v, want one compact step", steps)
	}
	step := steps[0].(map[string]any)
	if step["toolName"] != "Bash" {
		t.Fatalf("step = %#v, want normalized tool name", step)
	}
	input := step["toolInput"].(map[string]any)
	if input["command"] != "pwd" || input["rawInput"] != nil {
		t.Fatalf("step input = %#v, want flattened input", input)
	}
	output := step["toolResult"].(map[string]any)
	if output["stdout"] != "nested output" || output["text"] != "duplicate nested output" {
		t.Fatalf("step output = %#v, want canonical output text", output)
	}
	for _, key := range []string{"content", "rawOutput", "toolResponse"} {
		if output[key] != nil {
			t.Fatalf("step output retained %s: %#v", key, output)
		}
	}
}

func TestCompactToolCallPayloadProjectsFailedContentIntoError(t *testing.T) {
	got := CompactToolCallPayload("failed", map[string]any{
		"callId": "call-1",
		"content": []any{
			map[string]any{"type": "tool_result", "text": "permission denied"},
		},
	})

	if _, exists := got["content"]; exists {
		t.Fatalf("payload.content retained: %#v", got)
	}
	if _, exists := got["output"]; exists {
		t.Fatalf("failed content projected as output: %#v", got)
	}
	errorBody := got["error"].(map[string]any)
	if errorBody["text"] != "permission denied" {
		t.Fatalf("error = %#v, want projected text", errorBody)
	}
}

func TestCompactToolCallPayloadRetainsFormalFailureReason(t *testing.T) {
	got := CompactToolCallPayload("failed", map[string]any{
		"callId": "call-1",
		"error": map[string]any{
			"reason": "user_interrupt",
		},
	})

	errorBody := got["error"].(map[string]any)
	if errorBody["reason"] != "user_interrupt" {
		t.Fatalf("error = %#v, want formal failure reason", errorBody)
	}
}

func TestCompactToolCallPayloadRetainsFormalTextAndStreamFields(t *testing.T) {
	got := CompactToolCallPayload("completed", map[string]any{
		"callId": "call-1",
		"output": map[string]any{
			"text":   "same output",
			"stdout": "same output",
			"stderr": "same output",
		},
	})

	output := got["output"].(map[string]any)
	for _, key := range []string{"text", "stdout", "stderr"} {
		if output[key] != "same output" {
			t.Fatalf("output.%s = %#v, want formal field retained", key, output[key])
		}
	}
}

func TestCompactToolCallPayloadOmitsReconstructibleTerminalCommandText(t *testing.T) {
	got := CompactToolCallPayload("completed", map[string]any{
		"callId":   "call-1",
		"toolName": "Bash",
		"input": map[string]any{
			"command": "printf output",
		},
		"output": map[string]any{
			"text":   "same output",
			"stdout": "same output\n",
			"stderr": "warning\n",
		},
	})

	output := got["output"].(map[string]any)
	if _, exists := output["text"]; exists {
		t.Fatalf("output.text retained reconstructible command alias: %#v", output)
	}
	if output["stdout"] != "same output\n" || output["stderr"] != "warning\n" {
		t.Fatalf("output = %#v, want raw streams retained", output)
	}
}

func TestCompactToolCallPayloadOmitsReconstructibleTerminalCommandErrorText(t *testing.T) {
	got := CompactToolCallPayload("failed", map[string]any{
		"toolName": "shell_command",
		"input":    map[string]any{"command": "exit 1"},
		"error": map[string]any{
			"text":   "command failed",
			"stderr": "command failed\n",
		},
	})

	errorBody := got["error"].(map[string]any)
	if _, exists := errorBody["text"]; exists {
		t.Fatalf("error.text retained reconstructible command alias: %#v", errorBody)
	}
	if errorBody["stderr"] != "command failed\n" {
		t.Fatalf("error = %#v, want raw stderr retained", errorBody)
	}
}

func TestCompactToolCallPayloadCompactsTerminalAliasBeforeStreamTruncation(t *testing.T) {
	text := strings.Repeat("x", ToolOutputTextMaxBytes)
	got := CompactToolCallPayload("completed", map[string]any{
		"toolName": "Bash",
		"input":    map[string]any{"command": "print output"},
		"output":   map[string]any{"text": text, "stdout": text + "\n"},
	})

	output := got["output"].(map[string]any)
	if _, exists := output["text"]; exists {
		t.Fatalf("output.text retained alias across truncation boundary")
	}
	stdout := output["stdout"].(string)
	marked := strings.HasSuffix(stdout, ToolOutputTruncationMarker)
	if len(stdout) > ToolOutputTextMaxBytes || !marked {
		t.Fatalf("stdout has %d bytes and truncation marker %t, want bounded marked stream", len(stdout), marked)
	}
}

func TestCompactToolCallPayloadRetainsTextOutsideTerminalCommandAlias(t *testing.T) {
	tests := []struct {
		name    string
		status  string
		payload map[string]any
	}{
		{
			name:   "running command",
			status: "running",
			payload: map[string]any{
				"toolName": "Bash",
				"input":    map[string]any{"command": "printf output"},
				"output":   map[string]any{"text": "same output", "stdout": "same output\n"},
			},
		},
		{
			name:   "non-command tool",
			status: "completed",
			payload: map[string]any{
				"toolName": "Edit",
				"input":    map[string]any{"command": "domain command"},
				"output":   map[string]any{"text": "same output", "stdout": "same output\n"},
			},
		},
		{
			name:   "distinct command display text",
			status: "completed",
			payload: map[string]any{
				"toolName": "exec_command",
				"input":    map[string]any{"cmd": "printf raw"},
				"output":   map[string]any{"text": "formatted output", "stdout": "raw output\n"},
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := CompactToolCallPayload(test.status, test.payload)
			output := got["output"].(map[string]any)
			if output["text"] == nil {
				t.Fatalf("output.text removed: %#v", output)
			}
		})
	}
}

func TestCompactTerminalCommandOutputAliasesUsesNestedStepStatusRecursively(
	t *testing.T,
) {
	payload := map[string]any{
		"toolName": "Task",
		"output": map[string]any{
			"text":   "running task output",
			"stdout": "running task output\n",
		},
		"steps": []any{
			map[string]any{
				"toolName": "Bash",
				"status":   "completed",
				"toolInput": map[string]any{
					"command": "printf direct",
				},
				"toolResult": map[string]any{
					"text":   "direct output",
					"stdout": "direct output\n",
				},
			},
			map[string]any{
				"toolName": "Task",
				"status":   "running",
				"toolResult": map[string]any{
					"steps": []any{map[string]any{
						"toolName": "Bash",
						"status":   "failed",
						"toolInput": map[string]any{
							"command": "printf nested",
						},
						"toolError": map[string]any{
							"text":   "nested failure",
							"stderr": "nested failure\n",
						},
					}},
				},
			},
		},
	}

	if !CompactTerminalCommandOutputAliases("running", payload) {
		t.Fatal("completed nested command aliases were not compacted")
	}
	rootOutput := payload["output"].(map[string]any)
	if rootOutput["text"] == nil {
		t.Fatalf("running root text was removed: %#v", rootOutput)
	}
	steps := payload["steps"].([]any)
	direct := steps[0].(map[string]any)["toolResult"].(map[string]any)
	if _, exists := direct["text"]; exists {
		t.Fatalf("direct completed step retained text alias: %#v", direct)
	}
	nested := steps[1].(map[string]any)["toolResult"].(map[string]any)["steps"].([]any)[0].(map[string]any)["toolError"].(map[string]any)
	if _, exists := nested["text"]; exists {
		t.Fatalf("recursive failed step retained text alias: %#v", nested)
	}
}

func TestCompactToolCallPayloadFitsAggregateOutputBudget(t *testing.T) {
	largeText := strings.Repeat("t", ToolCallPayloadMaxBytes)
	largeStream := strings.Repeat("s", ToolCallPayloadMaxBytes) + "\n"
	input := strings.Repeat("i", 1024)
	got := CompactToolCallPayload("completed", map[string]any{
		"toolName": "McpResult",
		"callType": "mcp",
		"input":    map[string]any{"query": input},
		"output": map[string]any{
			"text":   largeText,
			"stdout": largeStream,
		},
	})

	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) > ToolCallPayloadMaxBytes {
		t.Fatalf("encoded payload has %d bytes, limit is %d", len(encoded), ToolCallPayloadMaxBytes)
	}
	if got["input"].(map[string]any)["query"] != input {
		t.Fatal("aggregate output budget changed tool input")
	}
	output := got["output"].(map[string]any)
	for _, key := range []string{"text", "stdout"} {
		value := output[key].(string)
		if !strings.HasSuffix(value, ToolOutputTruncationMarker) {
			t.Fatalf("output.%s does not carry truncation marker", key)
		}
	}
}

func TestCompactToolCallPayloadOmitsNestedTerminalCommandTextAlias(t *testing.T) {
	got := CompactToolCallPayload("completed", map[string]any{
		"toolName": "Task",
		"steps": []any{map[string]any{
			"toolName": "Bash",
			"status":   "completed",
			"toolInput": map[string]any{
				"command": "printf nested",
			},
			"toolResult": map[string]any{
				"text":   "nested output",
				"stdout": "nested output\n",
			},
		}},
	})

	step := got["steps"].([]any)[0].(map[string]any)
	output := step["toolResult"].(map[string]any)
	if _, exists := output["text"]; exists {
		t.Fatalf("nested output.text retained reconstructible alias: %#v", output)
	}
	if output["stdout"] != "nested output\n" {
		t.Fatalf("nested output = %#v, want raw stdout retained", output)
	}
}

func TestProjectMessageUpdateCompactsToolPayloadBeforePersistence(t *testing.T) {
	message, ok := ProjectMessageUpdate(MessageSnapshot{}, false, MessageUpdate{
		MessageID: "tool-1",
		TurnID:    "turn-1",
		Role:      "assistant",
		Kind:      "tool_call",
		Status:    "completed",
		Payload: map[string]any{
			"callId": "call-1",
			"content": []any{
				map[string]any{"type": "tool_result", "text": "done"},
			},
			"output": map[string]any{
				"toolResponse": map[string]any{"originalFile": "large snapshot"},
			},
		},
	}, 1, 100)
	if !ok {
		t.Fatal("(ProjectMessageUpdate()) rejected tool message")
	}
	if _, exists := message.Payload["content"]; exists {
		t.Fatalf("payload.content retained: %#v", message.Payload)
	}
	output := message.Payload["output"].(map[string]any)
	if output["text"] != "done" {
		t.Fatalf("output = %#v, want projected display text", output)
	}
	if _, exists := output["toolResponse"]; exists {
		t.Fatalf("output.toolResponse retained: %#v", output)
	}
}

func TestCompactToolCallPayloadDeduplicatesMCPStructuredContentAndFitsBudget(t *testing.T) {
	large := strings.Repeat("node-repl-output-", 1<<16)
	payload := map[string]any{
		"toolName": "node_repl.js",
		"input":    map[string]any{"code": "return value"},
		"content":  []any{map[string]any{"type": "text", "text": large}},
		"output": map[string]any{
			"structuredContent": map[string]any{
				"result": large,
				"meta":   map[string]any{"count": json.Number("9007199254740993")},
			},
		},
	}

	got, err := CompactToolCallPayloadChecked("completed", payload)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) > ToolCallPayloadMaxBytes {
		t.Fatalf("canonical payload has %d bytes, want at most %d", len(encoded), ToolCallPayloadMaxBytes)
	}
	output := got["output"].(map[string]any)
	if output["structuredContent"].(map[string]any)["result"] != ToolStructuredContentDuplicateTextMarker {
		t.Fatalf("structured content did not retain duplicate marker: %#v", output)
	}
	if !strings.HasSuffix(output["text"].(string), ToolOutputTruncationMarker) {
		t.Fatalf("projected text did not retain truncation marker: %#v", output["text"])
	}
	if payload["output"].(map[string]any)["structuredContent"].(map[string]any)["result"] != large {
		t.Fatal("input payload was mutated")
	}
}

func TestCompactToolCallPayloadFairlyTruncatesNestedStructuredStringsUTF8(t *testing.T) {
	large := strings.Repeat("界", ToolCallPayloadMaxBytes/2)
	got, err := CompactToolCallPayloadChecked("completed", map[string]any{
		"toolName": "node_repl.js",
		"input":    map[string]any{"code": "preserve me"},
		"output": map[string]any{
			"structuredContent": map[string]any{
				"first": large,
				"nested": map[string]any{
					"second": large,
					"items":  []any{large, map[string]any{"third": large}},
				},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if !utf8.Valid(encoded) || len(encoded) > ToolCallPayloadMaxBytes {
		t.Fatalf("encoded payload valid=%t bytes=%d", utf8.Valid(encoded), len(encoded))
	}
	structured := got["output"].(map[string]any)["structuredContent"].(map[string]any)
	values := []string{
		structured["first"].(string),
		structured["nested"].(map[string]any)["second"].(string),
		structured["nested"].(map[string]any)["items"].([]any)[0].(string),
		structured["nested"].(map[string]any)["items"].([]any)[1].(map[string]any)["third"].(string),
	}
	for _, value := range values {
		if !utf8.ValidString(value) || !strings.HasSuffix(value, ToolOutputTruncationMarker) {
			t.Fatalf("structured string is not UTF-8 safe with marker: %q", value[len(value)-64:])
		}
	}
	if got["input"].(map[string]any)["code"] != "preserve me" {
		t.Fatal("tool input changed")
	}
}

func TestCompactToolCallPayloadRejectsRequiredDataOverBudget(t *testing.T) {
	_, err := CompactToolCallPayloadChecked("completed", map[string]any{
		"toolName": "node_repl.js",
		"input":    map[string]any{"code": strings.Repeat("x", ToolCallPayloadMaxBytes)},
		"output":   map[string]any{"structuredContent": map[string]any{"count": 1}},
	})
	if !IsToolCallPayloadTooLarge(err) {
		t.Fatalf("error = %v, want tool payload budget error", err)
	}
}
