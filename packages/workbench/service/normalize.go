package workbenchservice

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
)

// NormalizeSnapshot validates and encodes a workbench snapshot in canonical form.
func NormalizeSnapshot(snapshot WorkbenchSnapshot) (json.RawMessage, int, error) {
	return normalizeWorkbenchSnapshot(snapshot)
}

func normalizeWorkbenchSnapshot(snapshot WorkbenchSnapshot) (json.RawMessage, int, error) {
	if snapshot.SchemaVersion != workbenchSnapshotContractSchemaVersion {
		return nil, 0, fmt.Errorf("unsupported workbench snapshot schema version: %d", snapshot.SchemaVersion)
	}
	if snapshot.Nodes == nil {
		return nil, 0, errors.New("workbench snapshot nodes are required")
	}
	if len(snapshot.Nodes) > workbenchSnapshotContractMaxNodes {
		return nil, 0, fmt.Errorf("workbench snapshot nodes must contain at most %d items", workbenchSnapshotContractMaxNodes)
	}

	ids := make(map[string]struct{}, len(snapshot.Nodes))
	for index, node := range snapshot.Nodes {
		if strings.TrimSpace(node.ID) == "" {
			return nil, 0, fmt.Errorf("workbench snapshot node %d id is required", index)
		}
		nodeID := strings.TrimSpace(node.ID)
		if _, exists := ids[nodeID]; exists {
			return nil, 0, fmt.Errorf("workbench snapshot node %d id is duplicated", index)
		}
		ids[nodeID] = struct{}{}
		if len(node.ID) > workbenchSnapshotContractMaxNodeIDLength {
			return nil, 0, fmt.Errorf("workbench snapshot node %d id is too long", index)
		}

		if strings.TrimSpace(node.Kind) == "" {
			return nil, 0, fmt.Errorf("workbench snapshot node %d kind is required", index)
		}
		if len(node.Kind) > workbenchSnapshotContractMaxKindLength {
			return nil, 0, fmt.Errorf("workbench snapshot node %d kind is too long", index)
		}
		if len(node.Title) > workbenchSnapshotContractMaxTitleLength {
			return nil, 0, fmt.Errorf("workbench snapshot node %d title is too long", index)
		}
		if node.DisplayMode != nil {
			if _, ok := workbenchSnapshotContractDisplayModes[*node.DisplayMode]; !ok {
				return nil, 0, fmt.Errorf("workbench snapshot node %d display mode is invalid", index)
			}
		}
		if err := validateWorkbenchFrame(node.Frame); err != nil {
			return nil, 0, fmt.Errorf("workbench snapshot node %d frame: %w", index, err)
		}
		if node.RestoreFrame != nil {
			if err := validateWorkbenchFrame(*node.RestoreFrame); err != nil {
				return nil, 0, fmt.Errorf("workbench snapshot node %d restore frame: %w", index, err)
			}
		}
		if node.MinimizedAtUnixMs != nil && *node.MinimizedAtUnixMs < 0 {
			return nil, 0, fmt.Errorf("workbench snapshot node %d minimized timestamp is invalid", index)
		}
	}
	if snapshot.NodeStack != nil {
		for index, nodeID := range *snapshot.NodeStack {
			if strings.TrimSpace(nodeID) == "" {
				return nil, 0, fmt.Errorf("workbench snapshot node stack item %d is required", index)
			}
		}
	}
	if snapshot.Spaces != nil {
		for index, space := range *snapshot.Spaces {
			if strings.TrimSpace(space.ID) == "" {
				return nil, 0, fmt.Errorf("workbench snapshot space %d id is required", index)
			}
			if space.NodeIDs == nil {
				return nil, 0, fmt.Errorf("workbench snapshot space %d node ids are required", index)
			}
			for nodeIDIndex, nodeID := range space.NodeIDs {
				if strings.TrimSpace(nodeID) == "" {
					return nil, 0, fmt.Errorf("workbench snapshot space %d node id %d is required", index, nodeIDIndex)
				}
			}
			if space.Frame != nil {
				if err := validateWorkbenchFrame(*space.Frame); err != nil {
					return nil, 0, fmt.Errorf("workbench snapshot space %d frame: %w", index, err)
				}
			}
		}
	}
	if snapshot.LayoutBasis != nil {
		if err := validateWorkbenchLayoutBasis(*snapshot.LayoutBasis); err != nil {
			return nil, 0, fmt.Errorf("workbench snapshot layout basis: %w", err)
		}
	}

	canonicalSnapshot := canonicalizeWorkbenchSnapshot(snapshot)
	normalizedJSON, err := json.Marshal(canonicalSnapshot)
	if err != nil {
		return nil, 0, fmt.Errorf("encode workbench snapshot: %w", err)
	}
	if len(normalizedJSON) > workbenchSnapshotContractMaxSerializedBytes {
		return nil, 0, fmt.Errorf("workbench snapshot exceeds %d bytes", workbenchSnapshotContractMaxSerializedBytes)
	}

	return normalizedJSON, snapshot.SchemaVersion, nil
}

type canonicalWorkbenchSnapshot struct {
	SchemaVersion int                                `json:"schemaVersion"`
	Nodes         []canonicalWorkbenchSnapshotNode   `json:"nodes"`
	NodeStack     []string                           `json:"nodeStack"`
	ActiveNodeID  *string                            `json:"activeNodeId"`
	Spaces        *[]canonicalWorkbenchSnapshotSpace `json:"spaces,omitempty"`
	ActiveSpaceID *string                            `json:"activeSpaceId"`
	LayoutBasis   *WorkbenchSnapshotLayoutBasis      `json:"layoutBasis,omitempty"`
	Metadata      map[string]interface{}             `json:"metadata,omitempty"`
}

type canonicalWorkbenchSnapshotNode struct {
	ID                string                       `json:"id"`
	Kind              string                       `json:"kind"`
	Title             string                       `json:"title"`
	Frame             WorkbenchSnapshotFrame       `json:"frame"`
	DisplayMode       WorkbenchSnapshotDisplayMode `json:"displayMode"`
	RestoreFrame      *WorkbenchSnapshotFrame      `json:"restoreFrame"`
	IsMinimized       bool                         `json:"isMinimized"`
	MinimizedAtUnixMs *int64                       `json:"minimizedAtUnixMs,omitempty"`
	Data              interface{}                  `json:"data,omitempty"`
	AdapterState      map[string]interface{}       `json:"adapterState,omitempty"`
}

type canonicalWorkbenchSnapshotSpace struct {
	ID      string                  `json:"id"`
	Name    string                  `json:"name"`
	NodeIDs []string                `json:"nodeIds"`
	Frame   *WorkbenchSnapshotFrame `json:"frame"`
	Data    interface{}             `json:"data,omitempty"`
}

func canonicalizeWorkbenchSnapshot(snapshot WorkbenchSnapshot) canonicalWorkbenchSnapshot {
	nodes := make([]canonicalWorkbenchSnapshotNode, len(snapshot.Nodes))
	for index, node := range snapshot.Nodes {
		nodes[index] = canonicalizeWorkbenchSnapshotNode(node)
	}
	sort.Slice(nodes, func(left, right int) bool {
		return nodes[left].ID < nodes[right].ID
	})

	nodeIDs := make(map[string]struct{}, len(nodes))
	for _, node := range nodes {
		nodeIDs[node.ID] = struct{}{}
	}

	nodeStack := uniqueTrimmedStrings(derefStringSlice(snapshot.NodeStack))
	filteredNodeStack := make([]string, 0, len(nodeStack))
	for _, nodeID := range nodeStack {
		if _, ok := nodeIDs[nodeID]; ok {
			filteredNodeStack = append(filteredNodeStack, nodeID)
		}
	}
	for _, node := range nodes {
		if !containsString(filteredNodeStack, node.ID) {
			filteredNodeStack = append(filteredNodeStack, node.ID)
		}
	}

	var spaces *[]canonicalWorkbenchSnapshotSpace
	spaceIDs := map[string]struct{}{}
	if snapshot.Spaces != nil {
		normalizedSpaces := make([]canonicalWorkbenchSnapshotSpace, len(*snapshot.Spaces))
		for index, space := range *snapshot.Spaces {
			normalizedSpaces[index] = canonicalizeWorkbenchSnapshotSpace(space)
		}
		sort.Slice(normalizedSpaces, func(left, right int) bool {
			return normalizedSpaces[left].ID < normalizedSpaces[right].ID
		})
		for _, space := range normalizedSpaces {
			spaceIDs[space.ID] = struct{}{}
		}
		spaces = &normalizedSpaces
	}

	return canonicalWorkbenchSnapshot{
		SchemaVersion: workbenchSnapshotContractSchemaVersion,
		Nodes:         nodes,
		NodeStack:     filteredNodeStack,
		ActiveNodeID:  canonicalActiveNodeID(snapshot.ActiveNodeID, filteredNodeStack, nodeIDs),
		Spaces:        spaces,
		ActiveSpaceID: canonicalActiveSpaceID(snapshot.ActiveSpaceID, spaces, spaceIDs),
		LayoutBasis:   canonicalizeWorkbenchLayoutBasis(snapshot.LayoutBasis),
		Metadata:      snapshot.Metadata,
	}
}

func canonicalizeWorkbenchSnapshotNode(node WorkbenchSnapshotNode) canonicalWorkbenchSnapshotNode {
	return canonicalWorkbenchSnapshotNode{
		ID:                strings.TrimSpace(node.ID),
		Kind:              strings.TrimSpace(node.Kind),
		Title:             node.Title,
		Frame:             canonicalizeWorkbenchFrame(node.Frame),
		DisplayMode:       canonicalDisplayMode(node.DisplayMode),
		RestoreFrame:      canonicalRestoreFrame(node.RestoreFrame),
		IsMinimized:       canonicalIsMinimized(node.IsMinimized),
		MinimizedAtUnixMs: canonicalMinimizedAtUnixMs(node.IsMinimized, node.MinimizedAtUnixMs),
		Data:              node.Data,
		AdapterState:      node.AdapterState,
	}
}

func canonicalizeWorkbenchSnapshotSpace(space WorkbenchSnapshotSpace) canonicalWorkbenchSnapshotSpace {
	return canonicalWorkbenchSnapshotSpace{
		ID:      strings.TrimSpace(space.ID),
		Name:    space.Name,
		NodeIDs: uniqueTrimmedStrings(space.NodeIDs),
		Frame:   canonicalRestoreFrame(space.Frame),
		Data:    space.Data,
	}
}

func canonicalizeWorkbenchFrame(frame WorkbenchSnapshotFrame) WorkbenchSnapshotFrame {
	return WorkbenchSnapshotFrame{
		X:      canonicalizeWorkbenchNumber(frame.X),
		Y:      canonicalizeWorkbenchNumber(frame.Y),
		Width:  math.Max(workbenchSnapshotContractMinFrameWidth, canonicalizeWorkbenchNumber(frame.Width)),
		Height: math.Max(workbenchSnapshotContractMinFrameHeight, canonicalizeWorkbenchNumber(frame.Height)),
	}
}

func canonicalizeWorkbenchLayoutBasis(
	layoutBasis *WorkbenchSnapshotLayoutBasis,
) *WorkbenchSnapshotLayoutBasis {
	if layoutBasis == nil {
		return nil
	}

	return &WorkbenchSnapshotLayoutBasis{
		SurfaceSize: WorkbenchSnapshotSize{
			Width:  canonicalizeWorkbenchNumber(layoutBasis.SurfaceSize.Width),
			Height: canonicalizeWorkbenchNumber(layoutBasis.SurfaceSize.Height),
		},
		LayoutConstraints: WorkbenchSnapshotLayoutConstraints{
			MinWidth:       canonicalizeWorkbenchNumber(layoutBasis.LayoutConstraints.MinWidth),
			MinHeight:      canonicalizeWorkbenchNumber(layoutBasis.LayoutConstraints.MinHeight),
			SurfacePadding: canonicalizeWorkbenchNumber(layoutBasis.LayoutConstraints.SurfacePadding),
			SafeArea: WorkbenchSnapshotSafeArea{
				Top:    canonicalizeWorkbenchNumber(layoutBasis.LayoutConstraints.SafeArea.Top),
				Right:  canonicalizeWorkbenchNumber(layoutBasis.LayoutConstraints.SafeArea.Right),
				Bottom: canonicalizeWorkbenchNumber(layoutBasis.LayoutConstraints.SafeArea.Bottom),
				Left:   canonicalizeWorkbenchNumber(layoutBasis.LayoutConstraints.SafeArea.Left),
			},
		},
	}
}

func canonicalizeWorkbenchNumber(value float64) float64 {
	normalized := math.Round(value*1000) / 1000
	if normalized == 0 {
		return 0
	}

	return normalized
}

func canonicalDisplayMode(displayMode *WorkbenchSnapshotDisplayMode) WorkbenchSnapshotDisplayMode {
	if displayMode == nil {
		return WorkbenchSnapshotDisplayModeFloating
	}

	return *displayMode
}

func canonicalRestoreFrame(frame *WorkbenchSnapshotFrame) *WorkbenchSnapshotFrame {
	if frame == nil {
		return nil
	}

	normalized := canonicalizeWorkbenchFrame(*frame)
	return &normalized
}

func canonicalIsMinimized(value *bool) bool {
	if value == nil {
		return false
	}

	return *value
}

func canonicalMinimizedAtUnixMs(isMinimized *bool, value *int64) *int64 {
	if !canonicalIsMinimized(isMinimized) || value == nil {
		return nil
	}

	normalized := *value
	return &normalized
}

func canonicalActiveNodeID(activeNodeID *string, nodeStack []string, nodeIDs map[string]struct{}) *string {
	if activeNodeID != nil {
		if _, ok := nodeIDs[*activeNodeID]; ok {
			return cloneStringPointer(*activeNodeID)
		}
	}
	if len(nodeStack) == 0 {
		return nil
	}

	return cloneStringPointer(nodeStack[len(nodeStack)-1])
}

func canonicalActiveSpaceID(
	activeSpaceID *string,
	spaces *[]canonicalWorkbenchSnapshotSpace,
	spaceIDs map[string]struct{},
) *string {
	if activeSpaceID != nil {
		if _, ok := spaceIDs[*activeSpaceID]; ok {
			return cloneStringPointer(*activeSpaceID)
		}
	}
	if spaces == nil || len(*spaces) == 0 {
		return nil
	}

	return cloneStringPointer((*spaces)[0].ID)
}

func derefStringSlice(value *[]string) []string {
	if value == nil {
		return nil
	}

	return append([]string(nil), (*value)...)
}

func uniqueTrimmedStrings(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}

	unique := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		unique = append(unique, trimmed)
	}

	return unique
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}

	return false
}

func cloneStringPointer(value string) *string {
	cloned := value
	return &cloned
}

func validateWorkbenchFrame(frame WorkbenchSnapshotFrame) error {
	if !isFinite(frame.X) || !isFinite(frame.Y) || !isFinite(frame.Width) || !isFinite(frame.Height) {
		return errors.New("numbers must be finite")
	}
	if frame.Width < workbenchSnapshotContractMinFrameWidth {
		return fmt.Errorf("width must be at least %d", workbenchSnapshotContractMinFrameWidth)
	}
	if frame.Height < workbenchSnapshotContractMinFrameHeight {
		return fmt.Errorf("height must be at least %d", workbenchSnapshotContractMinFrameHeight)
	}

	return nil
}

func validateWorkbenchLayoutBasis(layoutBasis WorkbenchSnapshotLayoutBasis) error {
	if !isPositiveFinite(layoutBasis.SurfaceSize.Width) || !isPositiveFinite(layoutBasis.SurfaceSize.Height) {
		return errors.New("surface size must contain positive finite numbers")
	}
	constraints := layoutBasis.LayoutConstraints
	if !isNonNegativeFinite(constraints.MinWidth) ||
		!isNonNegativeFinite(constraints.MinHeight) ||
		!isNonNegativeFinite(constraints.SurfacePadding) {
		return errors.New("layout constraints must contain non-negative finite numbers")
	}
	safeArea := constraints.SafeArea
	if !isNonNegativeFinite(safeArea.Top) ||
		!isNonNegativeFinite(safeArea.Right) ||
		!isNonNegativeFinite(safeArea.Bottom) ||
		!isNonNegativeFinite(safeArea.Left) {
		return errors.New("safe area must contain non-negative finite numbers")
	}
	return nil
}

func isPositiveFinite(value float64) bool {
	return isFinite(value) && value > 0
}

func isNonNegativeFinite(value float64) bool {
	return isFinite(value) && value >= 0
}

func isFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}
