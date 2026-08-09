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

func TestCanonicalFileChangesMovesRawCreatedBodyOutOfUnifiedDiff(t *testing.T) {
	t.Parallel()

	content := "# Liying\n\n- 自我介绍\n- 欢迎来到我的 README\n"
	got := canonicalFileChangesFromToolPayload(map[string]any{
		"fileChanges": map[string]any{
			"files": []any{map[string]any{
				"path":        "/workspace/README.md",
				"change":      "created",
				"unifiedDiff": content,
			}},
		},
	})
	files := payloadArray(got["files"])
	if len(files) != 1 {
		t.Fatalf("canonical files = %#v, want one file", files)
	}
	file := files[0]
	if file["change"] != "added" || file["newString"] != content {
		t.Fatalf("canonical file = %#v, want added file with its body in newString", file)
	}
	if _, exists := file["diff"]; exists {
		t.Fatalf("canonical file retained invalid diff: %#v", file)
	}
	if _, exists := file["unifiedDiff"]; exists {
		t.Fatalf("canonical file retained invalid unifiedDiff: %#v", file)
	}
}

func TestCanonicalFileChangesKeepsValidUnifiedDiff(t *testing.T) {
	t.Parallel()

	diff := "@@ -1 +1 @@\n-old\n+new"
	got := canonicalFileChangesFromToolPayload(map[string]any{
		"fileChanges": map[string]any{
			"files": []any{map[string]any{
				"path":        "/workspace/app.ts",
				"change":      "modified",
				"unifiedDiff": diff,
			}},
		},
	})
	file := payloadArray(got["files"])[0]
	if file["unifiedDiff"] != diff || file["diff"] != diff {
		t.Fatalf("canonical file = %#v, want valid unified diff preserved", file)
	}
}

func TestCanonicalFileChangesChoosesFirstValidDiffAlias(t *testing.T) {
	t.Parallel()

	valid := "@@ -1 +1 @@\n-old\n+new"
	rawBody := "README\n- bullet\n"
	got := canonicalFileChangesFromToolPayload(map[string]any{
		"fileChanges": map[string]any{
			"files": []any{map[string]any{
				"path":        "/workspace/app.ts",
				"change":      "modified",
				"diff":        rawBody,
				"unifiedDiff": valid,
			}},
		},
	})
	file := payloadArray(got["files"])[0]
	if file["diff"] != valid || file["unifiedDiff"] != valid {
		t.Fatalf("canonical file = %#v, want the valid later alias", file)
	}
}

func TestCanonicalFileChangesPreservesInvalidModifiedBodyWithoutDiff(t *testing.T) {
	t.Parallel()

	body := "README\n- bullet\n"
	got := canonicalFileChangesFromToolPayload(map[string]any{
		"fileChanges": map[string]any{
			"files": []any{map[string]any{
				"path":   "/workspace/README.md",
				"change": "modified",
				"diff":   body,
			}},
		},
	})
	file := payloadArray(got["files"])[0]
	if file["newString"] != body || file["change"] != "modified" {
		t.Fatalf("canonical file = %#v, want modified body preserved as newString", file)
	}
	if _, exists := file["diff"]; exists {
		t.Fatalf("canonical file retained invalid diff: %#v", file)
	}
	if _, exists := file["content"]; exists {
		t.Fatalf("canonical file retained obsolete content field: %#v", file)
	}
}

func TestLooksLikeUnifiedDiffRejectsPseudoHunks(t *testing.T) {
	t.Parallel()

	if looksLikeUnifiedDiff("@@ notes\n- bullet") {
		t.Fatal("pseudo hunk was accepted as a unified diff")
	}
	if !looksLikeUnifiedDiff("@@ -1 +1 @@\n-old\n+new") {
		t.Fatal("valid unified diff was rejected")
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

func TestMergeCanonicalFileChangesDeduplicatesAndCancelsCreatedFiles(t *testing.T) {
	t.Parallel()

	current := map[string]any{"files": []any{
		map[string]any{"path": "/workspace/a.txt", "change": "added", "newString": "first"},
		map[string]any{"path": "/workspace/a.txt", "change": "modified", "newString": "final"},
	}}
	incoming := map[string]any{"files": []any{
		map[string]any{"path": "/workspace/a.txt", "change": "deleted"},
		map[string]any{"path": "/workspace/b.txt", "change": "added", "newString": "b"},
	}}

	files := payloadArray(mergeCanonicalFileChanges(current, incoming)["files"])
	if len(files) != 1 || files[0]["path"] != "/workspace/b.txt" {
		t.Fatalf("merged files = %#v, want only the surviving file", files)
	}
}
