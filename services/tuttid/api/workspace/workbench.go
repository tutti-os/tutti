package workspace

import (
	"encoding/json"
	"fmt"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

func GeneratedWorkbenchResponseFromBiz(item workspacebiz.WorkbenchSnapshot) (tuttigenerated.WorkspaceWorkbenchResponse, error) {
	var snapshot tuttigenerated.WorkbenchSnapshot
	if err := json.Unmarshal(item.JSON, &snapshot); err != nil {
		return tuttigenerated.WorkspaceWorkbenchResponse{}, fmt.Errorf("decode stored workspace workbench snapshot: %w", err)
	}

	return tuttigenerated.WorkspaceWorkbenchResponse{
		Snapshot: snapshot,
	}, nil
}

func WorkbenchSnapshotFromGenerated(snapshot tuttigenerated.WorkbenchSnapshot) workspaceservice.WorkbenchSnapshot {
	var nodes []workspaceservice.WorkbenchSnapshotNode
	if snapshot.Nodes != nil {
		nodes = make([]workspaceservice.WorkbenchSnapshotNode, len(snapshot.Nodes))
		for index, node := range snapshot.Nodes {
			nodes[index] = workspaceservice.WorkbenchSnapshotNode{
				ID:           node.Id,
				Kind:         node.Kind,
				Title:        node.Title,
				Frame:        workbenchFrameFromGenerated(node.Frame),
				DisplayMode:  workbenchDisplayModeFromGenerated(node.DisplayMode),
				RestoreFrame: workbenchFramePointerFromGenerated(node.RestoreFrame),
				IsMinimized:  node.IsMinimized,
				Data:         node.Data,
				AdapterState: mapPointerValue(node.AdapterState),
			}
		}
	}

	return workspaceservice.WorkbenchSnapshot{
		SchemaVersion: int(snapshot.SchemaVersion),
		Nodes:         nodes,
		NodeStack:     cloneStringSlicePointer(snapshot.NodeStack),
		ActiveNodeID:  snapshot.ActiveNodeId,
		Spaces:        workbenchSpacesFromGenerated(snapshot.Spaces),
		ActiveSpaceID: snapshot.ActiveSpaceId,
		LayoutBasis:   workbenchLayoutBasisFromGenerated(snapshot.LayoutBasis),
		Metadata:      mapPointerValue(snapshot.Metadata),
	}
}

func workbenchLayoutBasisFromGenerated(
	layoutBasis *tuttigenerated.WorkbenchLayoutBasis,
) *workspaceservice.WorkbenchSnapshotLayoutBasis {
	if layoutBasis == nil {
		return nil
	}

	return &workspaceservice.WorkbenchSnapshotLayoutBasis{
		SurfaceSize: workspaceservice.WorkbenchSnapshotSize{
			Width:  float64(layoutBasis.SurfaceSize.Width),
			Height: float64(layoutBasis.SurfaceSize.Height),
		},
		LayoutConstraints: workspaceservice.WorkbenchSnapshotLayoutConstraints{
			MinWidth:       float64(layoutBasis.LayoutConstraints.MinWidth),
			MinHeight:      float64(layoutBasis.LayoutConstraints.MinHeight),
			SurfacePadding: float64(layoutBasis.LayoutConstraints.SurfacePadding),
			SafeArea: workspaceservice.WorkbenchSnapshotSafeArea{
				Top:    float64(layoutBasis.LayoutConstraints.SafeArea.Top),
				Right:  float64(layoutBasis.LayoutConstraints.SafeArea.Right),
				Bottom: float64(layoutBasis.LayoutConstraints.SafeArea.Bottom),
				Left:   float64(layoutBasis.LayoutConstraints.SafeArea.Left),
			},
		},
	}
}

func workbenchSpacesFromGenerated(
	spaces *[]tuttigenerated.WorkbenchSnapshotSpace,
) *[]workspaceservice.WorkbenchSnapshotSpace {
	if spaces == nil {
		return nil
	}

	inputs := make([]workspaceservice.WorkbenchSnapshotSpace, len(*spaces))
	for index, space := range *spaces {
		inputs[index] = workspaceservice.WorkbenchSnapshotSpace{
			ID:      space.Id,
			Name:    space.Name,
			NodeIDs: append([]string(nil), space.NodeIds...),
			Frame:   workbenchFramePointerFromGenerated(space.Frame),
			Data:    space.Data,
		}
	}

	return &inputs
}

func workbenchFramePointerFromGenerated(
	frame *tuttigenerated.WorkbenchFrame,
) *workspaceservice.WorkbenchSnapshotFrame {
	if frame == nil {
		return nil
	}

	input := workbenchFrameFromGenerated(*frame)
	return &input
}

func workbenchFrameFromGenerated(frame tuttigenerated.WorkbenchFrame) workspaceservice.WorkbenchSnapshotFrame {
	return workspaceservice.WorkbenchSnapshotFrame{
		X:      float64(frame.X),
		Y:      float64(frame.Y),
		Width:  float64(frame.Width),
		Height: float64(frame.Height),
	}
}

func workbenchDisplayModeFromGenerated(
	mode *tuttigenerated.WorkbenchSnapshotNodeDisplayMode,
) *workspaceservice.WorkbenchSnapshotDisplayMode {
	if mode == nil {
		return nil
	}

	value := workspaceservice.WorkbenchSnapshotDisplayMode(*mode)
	return &value
}

func cloneStringSlicePointer(value *[]string) *[]string {
	if value == nil {
		return nil
	}

	clone := append([]string(nil), (*value)...)
	return &clone
}

func mapPointerValue(value *map[string]interface{}) map[string]interface{} {
	if value == nil {
		return nil
	}

	return *value
}
