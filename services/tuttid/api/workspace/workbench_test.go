package workspace

import (
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

func TestWorkbenchSnapshotFromGeneratedPreservesCanonicalFields(t *testing.T) {
	t.Parallel()

	displayMode := tuttigenerated.WorkbenchSnapshotNodeDisplayMode("fullscreen")
	isMinimized := true
	activeNodeID := "workspace-files"
	activeSpaceID := "space-1"
	nodeStack := []string{"workspace-files"}
	metadata := map[string]interface{}{
		"initialized": true,
	}
	adapterState := map[string]interface{}{
		"reactFlow": map[string]interface{}{
			"type": "workspaceFilesNode",
		},
	}
	spaces := []tuttigenerated.WorkbenchSnapshotSpace{
		{
			Id:      "space-1",
			Name:    "Primary",
			NodeIds: []string{"workspace-files"},
			Frame: &tuttigenerated.WorkbenchFrame{
				X:      40,
				Y:      48,
				Width:  640,
				Height: 480,
			},
			Data: map[string]interface{}{
				"layout": "single",
			},
		},
	}
	layoutBasis := tuttigenerated.WorkbenchLayoutBasis{
		SurfaceSize: tuttigenerated.WorkbenchSize{
			Width:  1440,
			Height: 900,
		},
		LayoutConstraints: tuttigenerated.WorkbenchLayoutConstraints{
			MinWidth:       280,
			MinHeight:      160,
			SurfacePadding: 0,
			SafeArea: tuttigenerated.WorkbenchSafeArea{
				Top:    52,
				Right:  0,
				Bottom: 88,
				Left:   0,
			},
		},
	}

	snapshot := WorkbenchSnapshotFromGenerated(tuttigenerated.WorkbenchSnapshot{
		SchemaVersion: 1,
		Nodes: []tuttigenerated.WorkbenchSnapshotNode{
			{
				Id:    "workspace-files",
				Kind:  "workspaceFiles",
				Title: "Files",
				Frame: tuttigenerated.WorkbenchFrame{
					X:      12,
					Y:      18,
					Width:  400,
					Height: 320,
				},
				DisplayMode:  &displayMode,
				RestoreFrame: &tuttigenerated.WorkbenchFrame{X: 24, Y: 30, Width: 420, Height: 340},
				IsMinimized:  &isMinimized,
				Data:         map[string]interface{}{"workspaceID": "workspace-1"},
				AdapterState: &adapterState,
			},
		},
		NodeStack:     &nodeStack,
		ActiveNodeId:  &activeNodeID,
		Spaces:        &spaces,
		ActiveSpaceId: &activeSpaceID,
		LayoutBasis:   &layoutBasis,
		Metadata:      &metadata,
	})

	if snapshot.SchemaVersion != 1 {
		t.Fatalf("SchemaVersion = %d, want 1", snapshot.SchemaVersion)
	}
	if snapshot.ActiveNodeID == nil || *snapshot.ActiveNodeID != "workspace-files" {
		t.Fatalf("ActiveNodeID = %#v, want workspace-files", snapshot.ActiveNodeID)
	}
	if snapshot.ActiveSpaceID == nil || *snapshot.ActiveSpaceID != "space-1" {
		t.Fatalf("ActiveSpaceID = %#v, want space-1", snapshot.ActiveSpaceID)
	}
	if snapshot.NodeStack == nil || len(*snapshot.NodeStack) != 1 || (*snapshot.NodeStack)[0] != "workspace-files" {
		t.Fatalf("NodeStack = %#v, want workspace-files", snapshot.NodeStack)
	}
	if snapshot.Metadata["initialized"] != true {
		t.Fatalf("Metadata = %#v, want initialized=true", snapshot.Metadata)
	}
	if snapshot.LayoutBasis == nil || snapshot.LayoutBasis.SurfaceSize.Width != 1440 {
		t.Fatalf("LayoutBasis = %#v, want surface width 1440", snapshot.LayoutBasis)
	}
	if len(snapshot.Nodes) != 1 {
		t.Fatalf("nodes len = %d, want 1", len(snapshot.Nodes))
	}
	if snapshot.Nodes[0].DisplayMode == nil || *snapshot.Nodes[0].DisplayMode != workspaceservice.WorkbenchSnapshotDisplayModeFullscreen {
		t.Fatalf("DisplayMode = %#v, want fullscreen", snapshot.Nodes[0].DisplayMode)
	}
	if snapshot.Nodes[0].RestoreFrame == nil || snapshot.Nodes[0].RestoreFrame.Width != 420 {
		t.Fatalf("RestoreFrame = %#v, want width 420", snapshot.Nodes[0].RestoreFrame)
	}
	if snapshot.Nodes[0].AdapterState["reactFlow"] == nil {
		t.Fatalf("AdapterState = %#v, want reactFlow", snapshot.Nodes[0].AdapterState)
	}
	if snapshot.Spaces == nil || len(*snapshot.Spaces) != 1 {
		t.Fatalf("Spaces = %#v, want 1 space", snapshot.Spaces)
	}
	if (*snapshot.Spaces)[0].Frame == nil || (*snapshot.Spaces)[0].Frame.Width != 640 {
		t.Fatalf("Space frame = %#v, want width 640", (*snapshot.Spaces)[0].Frame)
	}
}
