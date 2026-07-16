package agentruntime

import "testing"

func TestCanonicalFileChangesNormalizeProviderShapes(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		payload map[string]any
		path    string
		change  string
	}{
		{
			name: "cursor delete kind",
			payload: map[string]any{
				"kind": "delete",
				"content": []any{map[string]any{
					"type": "diff", "path": "/workspace/obsolete.txt", "oldText": "obsolete", "newText": "",
				}},
			},
			path:   "/workspace/obsolete.txt",
			change: "deleted",
		},
		{
			name: "codex nested change kind",
			payload: map[string]any{
				"kind": "edit",
				"input": map[string]any{"changes": []any{map[string]any{
					"path": "/workspace/new.go", "kind": map[string]any{"type": "add"}, "diff": "@@ -0,0 +1 @@\n+package new",
				}}},
			},
			path:   "/workspace/new.go",
			change: "added",
		},
		{
			name: "claude structured patch change",
			payload: map[string]any{
				"output": map[string]any{"changes": []any{map[string]any{
					"path": "/workspace/app.ts", "type": "update", "diff": "@@ -1 +1 @@\n-old\n+new",
				}}},
			},
			path:   "/workspace/app.ts",
			change: "modified",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			files := payloadArray(canonicalFileChangesFromToolPayload(test.payload)["files"])
			if len(files) != 1 || files[0]["path"] != test.path || files[0]["change"] != test.change {
				t.Fatalf("canonical files = %#v, want %s %s", files, test.change, test.path)
			}
		})
	}
}

func TestMergeCanonicalFileChangesKeepsTurnLevelSemantics(t *testing.T) {
	t.Parallel()

	current := map[string]any{"files": []any{
		map[string]any{"path": "/workspace/new.ts", "change": "added", "oldString": "", "newString": "first"},
		map[string]any{"path": "/workspace/old.ts", "change": "modified", "oldString": "before", "newString": "after"},
	}}
	incoming := map[string]any{"files": []any{
		map[string]any{"path": "/workspace/new.ts", "change": "modified", "oldString": "first", "newString": "final"},
		map[string]any{"path": "/workspace/old.ts", "change": "deleted", "oldString": "after", "newString": ""},
	}}

	files := payloadArray(mergeCanonicalFileChanges(current, incoming)["files"])
	if len(files) != 2 {
		t.Fatalf("merged files = %#v, want two files", files)
	}
	if files[0]["change"] != "added" || files[0]["oldString"] != "" || files[0]["newString"] != "final" {
		t.Fatalf("created-then-edited file = %#v, want added with final content", files[0])
	}
	if files[1]["change"] != "deleted" || files[1]["oldString"] != "before" || files[1]["newString"] != "" {
		t.Fatalf("edited-then-deleted file = %#v, want deleted with original content", files[1])
	}
}
