package canonical

import (
	"reflect"
	"testing"
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
	if file["content"] != body || file["change"] != "modified" {
		t.Fatalf("file = %#v, want invalid body preserved as content", file)
	}
	if _, exists := file["diff"]; exists {
		t.Fatalf("file retained invalid diff: %#v", file)
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
		t.Fatal("ProjectMessageUpdate() rejected tool message")
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
