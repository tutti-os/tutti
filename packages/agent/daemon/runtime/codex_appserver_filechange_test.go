package agentruntime

import "testing"

func TestAppServerFileChangePreservesCwdInRawInput(t *testing.T) {
	item := map[string]any{
		"id":     "item-file-change",
		"type":   "fileChange",
		"status": "completed",
		"cwd":    "/workspace/project",
		"changes": []any{
			map[string]any{
				"path": "/workspace/project/src/app.ts",
				"kind": map[string]any{"type": "update"},
				"diff": "@@ -1 +1 @@\n-old\n+new\n",
			},
		},
	}

	update, ok := appServerItemToolCallUpdate(item, true)
	if !ok {
		t.Fatalf("expected fileChange item to produce an update")
	}
	rawInput, ok := update["rawInput"].(map[string]any)
	if !ok {
		t.Fatalf("rawInput = %#v, want map", update["rawInput"])
	}
	if got := asString(rawInput["cwd"]); got != "/workspace/project" {
		t.Fatalf("rawInput.cwd = %q, want /workspace/project", got)
	}
	if rawInput["changes"] == nil {
		t.Fatalf("rawInput.changes was not preserved")
	}
}
