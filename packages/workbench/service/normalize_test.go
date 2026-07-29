package workbenchservice

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

func TestNormalizeWorkbenchSnapshotRejectsTooLongNodeID(t *testing.T) {
	t.Parallel()

	_, _, err := normalizeWorkbenchSnapshot(tooLongNodeIDWorkbenchSnapshotFixture())
	if err == nil || !strings.Contains(err.Error(), "id is too long") {
		t.Fatalf("normalizeWorkbenchSnapshot() error = %v, want id length error", err)
	}
}

func TestNormalizeWorkbenchSnapshotRejectsUnknownDisplayMode(t *testing.T) {
	t.Parallel()

	_, _, err := normalizeWorkbenchSnapshot(invalidDisplayModeWorkbenchSnapshotFixture())
	if err == nil || !strings.Contains(err.Error(), "display mode is invalid") {
		t.Fatalf("normalizeWorkbenchSnapshot() error = %v, want display mode error", err)
	}
}

func TestNormalizeWorkbenchSnapshotRejectsDuplicateNodeID(t *testing.T) {
	t.Parallel()

	_, _, err := normalizeWorkbenchSnapshot(duplicateNodeIDWorkbenchSnapshotFixture())
	if err == nil || !strings.Contains(err.Error(), "id is duplicated") {
		t.Fatalf("normalizeWorkbenchSnapshot() error = %v, want duplicate id error", err)
	}
}

func TestNormalizeWorkbenchSnapshotRejectsInvalidFrame(t *testing.T) {
	t.Parallel()

	_, _, err := normalizeWorkbenchSnapshot(invalidFrameWorkbenchSnapshotFixture())
	if err == nil || !strings.Contains(err.Error(), "width must be at least") {
		t.Fatalf("normalizeWorkbenchSnapshot() error = %v, want frame width error", err)
	}
}

func TestNormalizeWorkbenchSnapshotRejectsInvalidMinimizedTimestamp(t *testing.T) {
	t.Parallel()

	_, _, err := normalizeWorkbenchSnapshot(invalidMinimizedTimestampWorkbenchSnapshotFixture())
	if err == nil || !strings.Contains(err.Error(), "minimized timestamp is invalid") {
		t.Fatalf("normalizeWorkbenchSnapshot() error = %v, want minimized timestamp error", err)
	}
}

func TestNormalizeWorkbenchSnapshotRejectsInvalidLayoutBasis(t *testing.T) {
	t.Parallel()

	snapshot := workbenchSnapshotWithSpacesFixture()
	snapshot.LayoutBasis.SurfaceSize.Width = 0
	_, _, err := normalizeWorkbenchSnapshot(snapshot)
	if err == nil || !strings.Contains(err.Error(), "surface size") {
		t.Fatalf("normalizeWorkbenchSnapshot() error = %v, want layout basis surface size error", err)
	}
}

func TestNormalizeWorkbenchSnapshotRejectsOversizedPayload(t *testing.T) {
	t.Parallel()

	_, _, err := normalizeWorkbenchSnapshot(oversizedWorkbenchSnapshotFixture())
	if err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("normalizeWorkbenchSnapshot() error = %v, want oversized snapshot error", err)
	}
}

func TestNormalizeWorkbenchSnapshotEncodesCanonicalFields(t *testing.T) {
	t.Parallel()

	normalizedJSON, schemaVersion, err := normalizeWorkbenchSnapshot(
		workbenchSnapshotWithSpacesFixture(),
	)
	if err != nil {
		t.Fatalf("normalizeWorkbenchSnapshot() error = %v", err)
	}
	if schemaVersion != workbenchSnapshotContractSchemaVersion {
		t.Fatalf("schemaVersion = %d, want %d", schemaVersion, workbenchSnapshotContractSchemaVersion)
	}

	var decoded WorkbenchSnapshot
	if err := json.Unmarshal(normalizedJSON, &decoded); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if decoded.ActiveSpaceID == nil || *decoded.ActiveSpaceID != "space-1" {
		t.Fatalf("ActiveSpaceID = %#v, want space-1", decoded.ActiveSpaceID)
	}
	if len(decoded.Nodes) != 1 {
		t.Fatalf("nodes len = %d, want 1", len(decoded.Nodes))
	}
	if decoded.Nodes[0].RestoreFrame == nil || decoded.Nodes[0].RestoreFrame.Width != 420 {
		t.Fatalf("RestoreFrame = %#v, want width 420", decoded.Nodes[0].RestoreFrame)
	}
	if decoded.Nodes[0].MinimizedAtUnixMs == nil || *decoded.Nodes[0].MinimizedAtUnixMs != 1720000000000 {
		t.Fatalf("MinimizedAtUnixMs = %#v, want 1720000000000", decoded.Nodes[0].MinimizedAtUnixMs)
	}
	if decoded.Spaces == nil || len(*decoded.Spaces) != 1 {
		t.Fatalf("Spaces = %#v, want 1 space", decoded.Spaces)
	}
	if (*decoded.Spaces)[0].Frame == nil || (*decoded.Spaces)[0].Frame.Width != 640 {
		t.Fatalf("Space frame = %#v, want width 640", (*decoded.Spaces)[0].Frame)
	}
	if decoded.LayoutBasis == nil || decoded.LayoutBasis.SurfaceSize.Width != 1440 {
		t.Fatalf("LayoutBasis = %#v, want surface width 1440", decoded.LayoutBasis)
	}
	if decoded.Metadata["initialized"] != true {
		t.Fatalf("Metadata = %#v, want initialized=true", decoded.Metadata)
	}
}

func TestNormalizeWorkbenchSnapshotCanonicalizesTrimmedOrderingDefaultsAndNulls(t *testing.T) {
	t.Parallel()

	normalizedJSON, _, err := normalizeWorkbenchSnapshot(
		canonicalizationWorkbenchSnapshotFixture(),
	)
	if err != nil {
		t.Fatalf("normalizeWorkbenchSnapshot() error = %v", err)
	}

	var decoded map[string]interface{}
	if err := json.Unmarshal(normalizedJSON, &decoded); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}

	nodes, ok := decoded["nodes"].([]interface{})
	if !ok || len(nodes) != 2 {
		t.Fatalf("nodes = %#v, want 2 canonical nodes", decoded["nodes"])
	}
	firstNode, ok := nodes[0].(map[string]interface{})
	if !ok {
		t.Fatalf("first node = %#v, want object", nodes[0])
	}
	secondNode, ok := nodes[1].(map[string]interface{})
	if !ok {
		t.Fatalf("second node = %#v, want object", nodes[1])
	}
	if firstNode["id"] != "a" || secondNode["id"] != "b" {
		t.Fatalf("node ids = %#v / %#v, want a then b", firstNode["id"], secondNode["id"])
	}
	if firstNode["kind"] != "agent" {
		t.Fatalf("first node kind = %#v, want trimmed agent", firstNode["kind"])
	}
	frame, ok := secondNode["frame"].(map[string]interface{})
	if !ok {
		t.Fatalf("second node frame = %#v, want object", secondNode["frame"])
	}
	if frame["x"] != float64(0) || frame["y"] != float64(3.142) {
		t.Fatalf("frame coordinates = %#v, want x=0 y=3.142", frame)
	}
	if secondNode["displayMode"] != "floating" {
		t.Fatalf("second node displayMode = %#v, want floating default", secondNode["displayMode"])
	}
	if secondNode["isMinimized"] != false {
		t.Fatalf("second node isMinimized = %#v, want false default", secondNode["isMinimized"])
	}
	if restoreFrame, exists := secondNode["restoreFrame"]; !exists || restoreFrame != nil {
		t.Fatalf("second node restoreFrame = %#v (exists=%t), want explicit null", restoreFrame, exists)
	}

	nodeStack, ok := decoded["nodeStack"].([]interface{})
	if !ok || len(nodeStack) != 2 || nodeStack[0] != "b" || nodeStack[1] != "a" {
		t.Fatalf("nodeStack = %#v, want [b a]", decoded["nodeStack"])
	}
	if decoded["activeNodeId"] != "a" {
		t.Fatalf("activeNodeId = %#v, want fallback a", decoded["activeNodeId"])
	}

	spaces, ok := decoded["spaces"].([]interface{})
	if !ok || len(spaces) != 2 {
		t.Fatalf("spaces = %#v, want 2 canonical spaces", decoded["spaces"])
	}
	firstSpace, ok := spaces[0].(map[string]interface{})
	if !ok {
		t.Fatalf("first space = %#v, want object", spaces[0])
	}
	secondSpace, ok := spaces[1].(map[string]interface{})
	if !ok {
		t.Fatalf("second space = %#v, want object", spaces[1])
	}
	if firstSpace["id"] != "space-a" || secondSpace["id"] != "space-z" {
		t.Fatalf("space ids = %#v / %#v, want space-a then space-z", firstSpace["id"], secondSpace["id"])
	}
	firstSpaceNodeIDs, ok := firstSpace["nodeIds"].([]interface{})
	if !ok || len(firstSpaceNodeIDs) != 1 || firstSpaceNodeIDs[0] != "a" {
		t.Fatalf("first space nodeIds = %#v, want trimmed unique [a]", firstSpace["nodeIds"])
	}
	if frameValue, exists := firstSpace["frame"]; !exists || frameValue != nil {
		t.Fatalf("first space frame = %#v (exists=%t), want explicit null", frameValue, exists)
	}
	if decoded["activeSpaceId"] != "space-a" {
		t.Fatalf("activeSpaceId = %#v, want fallback space-a", decoded["activeSpaceId"])
	}
}

func workbenchSnapshotWithSpacesFixture() WorkbenchSnapshot {
	displayMode := WorkbenchSnapshotDisplayModeFullscreen
	isMinimized := true
	minimizedAtUnixMs := int64(1720000000000)
	nodeStack := []string{"workspace-files"}
	activeNodeID := "workspace-files"
	activeSpaceID := "space-1"
	spaces := []WorkbenchSnapshotSpace{
		{
			ID:      "space-1",
			Name:    "Primary",
			NodeIDs: []string{"workspace-files"},
			Frame: &WorkbenchSnapshotFrame{
				X:      40,
				Y:      48,
				Width:  640,
				Height: 480,
			},
			Data: map[string]interface{}{"layout": "single"},
		},
	}

	return WorkbenchSnapshot{
		SchemaVersion: workbenchSnapshotContractSchemaVersion,
		Nodes: []WorkbenchSnapshotNode{
			{
				ID:    "workspace-files",
				Kind:  "workspaceFiles",
				Title: "Files",
				Frame: WorkbenchSnapshotFrame{
					X:      12,
					Y:      18,
					Width:  400,
					Height: 320,
				},
				DisplayMode: &displayMode,
				RestoreFrame: &WorkbenchSnapshotFrame{
					X:      24,
					Y:      30,
					Width:  420,
					Height: 340,
				},
				IsMinimized:       &isMinimized,
				MinimizedAtUnixMs: &minimizedAtUnixMs,
				Data:              map[string]interface{}{"workspaceID": "workspace-1"},
				AdapterState: map[string]interface{}{
					"reactFlow": map[string]interface{}{
						"type": "workspaceFilesNode",
						"measured": map[string]interface{}{
							"width":  400,
							"height": 320,
						},
					},
				},
			},
		},
		NodeStack:     &nodeStack,
		ActiveNodeID:  &activeNodeID,
		Spaces:        &spaces,
		ActiveSpaceID: &activeSpaceID,
		LayoutBasis: &WorkbenchSnapshotLayoutBasis{
			SurfaceSize: WorkbenchSnapshotSize{
				Width:  1440,
				Height: 900,
			},
			LayoutConstraints: WorkbenchSnapshotLayoutConstraints{
				MinWidth:       280,
				MinHeight:      160,
				SurfacePadding: 0,
				SafeArea: WorkbenchSnapshotSafeArea{
					Top:    52,
					Right:  0,
					Bottom: 88,
					Left:   0,
				},
			},
		},
		Metadata: map[string]interface{}{"initialized": true},
	}
}

func duplicateNodeIDWorkbenchSnapshotFixture() WorkbenchSnapshot {
	return WorkbenchSnapshot{
		SchemaVersion: workbenchSnapshotContractSchemaVersion,
		Nodes: []WorkbenchSnapshotNode{
			{
				ID:    "duplicate-node",
				Kind:  "terminal",
				Title: "First",
				Frame: validWorkbenchSnapshotFrame(),
			},
			{
				ID:    "duplicate-node",
				Kind:  "workspaceOverview",
				Title: "Second",
				Frame: validWorkbenchSnapshotFrame(),
			},
		},
	}
}

func invalidDisplayModeWorkbenchSnapshotFixture() WorkbenchSnapshot {
	displayMode := WorkbenchSnapshotDisplayMode("tabbed")

	return WorkbenchSnapshot{
		SchemaVersion: workbenchSnapshotContractSchemaVersion,
		Nodes: []WorkbenchSnapshotNode{
			{
				ID:          "node-1",
				Kind:        "terminal",
				Title:       "Terminal",
				Frame:       validWorkbenchSnapshotFrame(),
				DisplayMode: &displayMode,
			},
		},
	}
}

func invalidFrameWorkbenchSnapshotFixture() WorkbenchSnapshot {
	return WorkbenchSnapshot{
		SchemaVersion: workbenchSnapshotContractSchemaVersion,
		Nodes: []WorkbenchSnapshotNode{
			{
				ID:    "node-1",
				Kind:  "terminal",
				Title: "Terminal",
				Frame: WorkbenchSnapshotFrame{
					X:      0,
					Y:      0,
					Width:  workbenchSnapshotContractMinFrameWidth - 1,
					Height: workbenchSnapshotContractMinFrameHeight - 1,
				},
			},
		},
	}
}

func invalidMinimizedTimestampWorkbenchSnapshotFixture() WorkbenchSnapshot {
	minimizedAtUnixMs := int64(-1)
	return WorkbenchSnapshot{
		SchemaVersion: workbenchSnapshotContractSchemaVersion,
		Nodes: []WorkbenchSnapshotNode{
			{
				ID:                "node-1",
				Kind:              "terminal",
				Title:             "Terminal",
				Frame:             validWorkbenchSnapshotFrame(),
				MinimizedAtUnixMs: &minimizedAtUnixMs,
			},
		},
	}
}

func oversizedWorkbenchSnapshotFixture() WorkbenchSnapshot {
	return WorkbenchSnapshot{
		SchemaVersion: workbenchSnapshotContractSchemaVersion,
		Nodes:         []WorkbenchSnapshotNode{},
		Metadata: map[string]interface{}{
			"payload": strings.Repeat("x", workbenchSnapshotContractMaxSerializedBytes),
		},
	}
}

func tooLongNodeIDWorkbenchSnapshotFixture() WorkbenchSnapshot {
	return WorkbenchSnapshot{
		SchemaVersion: workbenchSnapshotContractSchemaVersion,
		Nodes: []WorkbenchSnapshotNode{
			{
				ID:    strings.Repeat("a", workbenchSnapshotContractMaxNodeIDLength+1),
				Kind:  "workspaceFiles",
				Title: "Files",
				Frame: validWorkbenchSnapshotFrame(),
			},
		},
	}
}

func validWorkbenchSnapshotFrame() WorkbenchSnapshotFrame {
	return WorkbenchSnapshotFrame{
		X:      0,
		Y:      0,
		Width:  workbenchSnapshotContractMinFrameWidth,
		Height: workbenchSnapshotContractMinFrameHeight,
	}
}

func canonicalizationWorkbenchSnapshotFixture() WorkbenchSnapshot {
	nodeStack := []string{" b ", "missing", "a", "a"}
	activeNodeID := " missing "
	activeSpaceID := " missing "
	spaces := []WorkbenchSnapshotSpace{
		{
			ID:      " space-z ",
			Name:    "Later",
			NodeIDs: []string{" b ", "b"},
			Frame: &WorkbenchSnapshotFrame{
				X:      10,
				Y:      11,
				Width:  320,
				Height: 240,
			},
		},
		{
			ID:      " space-a ",
			Name:    "Earlier",
			NodeIDs: []string{" a ", "a"},
			Frame:   nil,
		},
	}

	return WorkbenchSnapshot{
		SchemaVersion: workbenchSnapshotContractSchemaVersion,
		Nodes: []WorkbenchSnapshotNode{
			{
				ID:    " b ",
				Kind:  " terminal ",
				Title: "Terminal",
				Frame: WorkbenchSnapshotFrame{
					X:      math.Copysign(0, -1),
					Y:      3.14159,
					Width:  200,
					Height: 150,
				},
				DisplayMode: nil,
				Data:        map[string]interface{}{"workspaceID": "workspace-1"},
			},
			{
				ID:    " a ",
				Kind:  " agent ",
				Title: "Agent",
				Frame: WorkbenchSnapshotFrame{
					X:      10,
					Y:      10,
					Width:  180,
					Height: 140,
				},
			},
		},
		NodeStack:     &nodeStack,
		ActiveNodeID:  &activeNodeID,
		Spaces:        &spaces,
		ActiveSpaceID: &activeSpaceID,
	}
}
