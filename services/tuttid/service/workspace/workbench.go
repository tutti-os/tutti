package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	workbenchservice "github.com/tutti-os/tutti/packages/workbench/service"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

var ErrInvalidWorkbenchSnapshot = workbenchservice.ErrInvalidWorkbenchSnapshot

type WorkbenchSnapshot = workbenchservice.WorkbenchSnapshot
type WorkbenchSnapshotNode = workbenchservice.WorkbenchSnapshotNode
type WorkbenchSnapshotSpace = workbenchservice.WorkbenchSnapshotSpace
type WorkbenchSnapshotFrame = workbenchservice.WorkbenchSnapshotFrame
type WorkbenchSnapshotSize = workbenchservice.WorkbenchSnapshotSize
type WorkbenchSnapshotSafeArea = workbenchservice.WorkbenchSnapshotSafeArea
type WorkbenchSnapshotLayoutConstraints = workbenchservice.WorkbenchSnapshotLayoutConstraints
type WorkbenchSnapshotLayoutBasis = workbenchservice.WorkbenchSnapshotLayoutBasis
type WorkbenchSnapshotDisplayMode = workbenchservice.WorkbenchSnapshotDisplayMode

const (
	WorkbenchSnapshotDisplayModeFloating   = workbenchservice.WorkbenchSnapshotDisplayModeFloating
	WorkbenchSnapshotDisplayModeFullscreen = workbenchservice.WorkbenchSnapshotDisplayModeFullscreen
)

type WorkbenchTerminalLister interface {
	List(context.Context, string) ([]TerminalSession, error)
}

type WorkbenchSnapshotReconciler interface {
	ReconcileSnapshot(context.Context, workspacebiz.WorkbenchSnapshot) (workspacebiz.WorkbenchSnapshot, error)
}

type WorkbenchService struct {
	Store              workspacedata.WorkbenchStore
	SnapshotReconciler WorkbenchSnapshotReconciler
}

func (s WorkbenchService) GetSnapshot(ctx context.Context, workspaceID string) (workspacebiz.WorkbenchSnapshot, error) {
	if s.Store == nil {
		return workspacebiz.WorkbenchSnapshot{}, errors.New("workspace workbench store is not configured")
	}

	snapshot, err := workbenchservice.Service{
		Store: workbenchStoreAdapter{Store: s.Store},
	}.GetSnapshot(ctx, workspaceID)
	if err != nil {
		return workspacebiz.WorkbenchSnapshot{}, err
	}

	result := workspacebiz.WorkbenchSnapshot{
		WorkspaceID:   snapshot.WorkspaceID,
		SchemaVersion: snapshot.SchemaVersion,
		JSON:          snapshot.JSON,
	}

	return s.reconcileSnapshot(ctx, result)
}

func (s WorkbenchService) PutSnapshot(
	ctx context.Context,
	workspaceID string,
	snapshotInput WorkbenchSnapshot,
) (workspacebiz.WorkbenchSnapshot, error) {
	if s.Store == nil {
		return workspacebiz.WorkbenchSnapshot{}, errors.New("workspace workbench store is not configured")
	}

	snapshot, err := workbenchservice.Service{
		Store: workbenchStoreAdapter{Store: s.Store},
	}.PutSnapshot(ctx, workspaceID, snapshotInput)
	if err != nil {
		return workspacebiz.WorkbenchSnapshot{}, err
	}

	return workspacebiz.WorkbenchSnapshot{
		WorkspaceID:   snapshot.WorkspaceID,
		SchemaVersion: snapshot.SchemaVersion,
		JSON:          snapshot.JSON,
	}, nil
}

type workbenchStoreAdapter struct {
	Store workspacedata.WorkbenchStore
}

func (a workbenchStoreAdapter) GetSnapshot(ctx context.Context, workspaceID string) (workbenchservice.StoredSnapshot, error) {
	snapshot, err := a.Store.GetWorkbenchSnapshot(ctx, workspaceID)
	if errors.Is(err, workspacedata.ErrWorkbenchSnapshotNotFound) {
		return workbenchservice.StoredSnapshot{}, workbenchservice.ErrWorkbenchSnapshotNotFound
	}
	if err != nil {
		return workbenchservice.StoredSnapshot{}, err
	}

	return workbenchservice.StoredSnapshot{
		WorkspaceID:   snapshot.WorkspaceID,
		SchemaVersion: snapshot.SchemaVersion,
		JSON:          snapshot.JSON,
	}, nil
}

func (a workbenchStoreAdapter) PutSnapshot(ctx context.Context, snapshot workbenchservice.StoredSnapshot) error {
	return a.Store.PutWorkbenchSnapshot(ctx, workspacebiz.WorkbenchSnapshot{
		WorkspaceID:   snapshot.WorkspaceID,
		SchemaVersion: snapshot.SchemaVersion,
		JSON:          snapshot.JSON,
	})
}

func (s WorkbenchService) reconcileSnapshot(
	ctx context.Context,
	stored workspacebiz.WorkbenchSnapshot,
) (workspacebiz.WorkbenchSnapshot, error) {
	if s.SnapshotReconciler == nil {
		return stored, nil
	}
	return s.SnapshotReconciler.ReconcileSnapshot(ctx, stored)
}

type TerminalWorkbenchSnapshotReconciler struct {
	TerminalService WorkbenchTerminalLister
}

func (r TerminalWorkbenchSnapshotReconciler) ReconcileSnapshot(
	ctx context.Context,
	stored workspacebiz.WorkbenchSnapshot,
) (workspacebiz.WorkbenchSnapshot, error) {
	if r.TerminalService == nil {
		return stored, nil
	}

	var snapshot WorkbenchSnapshot
	if err := json.Unmarshal(stored.JSON, &snapshot); err != nil {
		return stored, nil
	}

	sessions, err := r.TerminalService.List(ctx, stored.WorkspaceID)
	if err != nil {
		return stored, nil
	}
	sessionIDs := make(map[string]struct{}, len(sessions))
	for _, session := range sessions {
		sessionID := strings.TrimSpace(session.ID)
		if sessionID != "" {
			sessionIDs[sessionID] = struct{}{}
		}
	}

	filtered, changed := filterMissingTerminalSnapshotNodes(snapshot, sessionIDs)
	if !changed {
		return stored, nil
	}

	normalizedJSON, schemaVersion, err := workbenchservice.NormalizeSnapshot(filtered)
	if err != nil {
		return stored, nil
	}
	return workspacebiz.WorkbenchSnapshot{
		WorkspaceID:   stored.WorkspaceID,
		SchemaVersion: schemaVersion,
		JSON:          normalizedJSON,
	}, nil
}

func filterMissingTerminalSnapshotNodes(
	snapshot WorkbenchSnapshot,
	sessionIDs map[string]struct{},
) (WorkbenchSnapshot, bool) {
	filteredNodes := make([]WorkbenchSnapshotNode, 0, len(snapshot.Nodes))
	removedNodeIDs := make(map[string]struct{})
	for _, node := range snapshot.Nodes {
		if isMissingTerminalSnapshotNode(node, sessionIDs) {
			removedNodeIDs[strings.TrimSpace(node.ID)] = struct{}{}
			continue
		}
		filteredNodes = append(filteredNodes, node)
	}
	if len(removedNodeIDs) == 0 {
		return snapshot, false
	}

	snapshot.Nodes = filteredNodes
	if snapshot.NodeStack != nil {
		nodeStack := filterWorkbenchNodeIDs(*snapshot.NodeStack, removedNodeIDs)
		snapshot.NodeStack = &nodeStack
	}
	if snapshot.Spaces != nil {
		spaces := make([]WorkbenchSnapshotSpace, len(*snapshot.Spaces))
		for index, space := range *snapshot.Spaces {
			spaces[index] = space
			spaces[index].NodeIDs = filterWorkbenchNodeIDs(space.NodeIDs, removedNodeIDs)
		}
		snapshot.Spaces = &spaces
	}

	return snapshot, true
}

func isMissingTerminalSnapshotNode(
	node WorkbenchSnapshotNode,
	sessionIDs map[string]struct{},
) bool {
	if !isTerminalWorkbenchSnapshotNode(node) {
		return false
	}
	candidates := terminalSnapshotNodeSessionIDCandidates(node.Data)
	if len(candidates) == 0 {
		return false
	}
	for _, candidate := range candidates {
		if _, ok := sessionIDs[candidate]; ok {
			return false
		}
	}
	return true
}

func isTerminalWorkbenchSnapshotNode(node WorkbenchSnapshotNode) bool {
	if strings.TrimSpace(node.Kind) == "terminal" {
		return true
	}
	data, ok := node.Data.(map[string]interface{})
	if !ok {
		return false
	}
	return strings.TrimSpace(stringMapValue(data, "typeId")) == "workspace-terminal"
}

func terminalSnapshotNodeSessionIDCandidates(data interface{}) []string {
	values, ok := data.(map[string]interface{})
	if !ok {
		return nil
	}

	candidates := make([]string, 0, 2)
	for _, key := range []string{"instanceKey", "instanceId"} {
		value := strings.TrimSpace(stringMapValue(values, key))
		if value == "" || containsString(candidates, value) || value == "workspace-terminal" || value == "terminal" {
			continue
		}
		candidates = append(candidates, value)
	}
	return candidates
}

func filterWorkbenchNodeIDs(nodeIDs []string, removed map[string]struct{}) []string {
	filtered := make([]string, 0, len(nodeIDs))
	for _, nodeID := range nodeIDs {
		if _, ok := removed[strings.TrimSpace(nodeID)]; ok {
			continue
		}
		filtered = append(filtered, nodeID)
	}
	return filtered
}

func stringMapValue(values map[string]interface{}, key string) string {
	value, ok := values[key].(string)
	if !ok {
		return ""
	}
	return value
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
