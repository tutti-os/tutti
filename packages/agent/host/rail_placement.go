package agenthost

import (
	"context"
	"fmt"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

const railPlacementVersion = 1

func normalizeRailPlacement(placement *RailPlacement) (*RailPlacement, error) {
	if placement == nil {
		return nil, nil
	}
	normalized := &RailPlacement{
		Version:     placement.Version,
		Kind:        RailPlacementKind(strings.TrimSpace(string(placement.Kind))),
		ProjectPath: strings.TrimSpace(placement.ProjectPath),
		SectionKey:  strings.TrimSpace(placement.SectionKey),
	}
	if normalized.Version != railPlacementVersion {
		return nil, fmt.Errorf("%w: unsupported rail placement version", ErrInvalidArgument)
	}
	switch normalized.Kind {
	case RailPlacementKindConversations:
		normalized.ProjectPath = ""
		normalized.SectionKey = storesqlite.RailSectionKeyConversations
	case RailPlacementKindProject:
		normalized.ProjectPath = storesqlite.NormalizeProjectPath(normalized.ProjectPath)
		if normalized.ProjectPath == "" {
			key := storesqlite.NormalizeRailSectionKey(normalized.SectionKey)
			if strings.HasPrefix(key, "project:") {
				normalized.ProjectPath = storesqlite.NormalizeProjectPath(
					strings.TrimPrefix(key, "project:"),
				)
			}
		}
		if normalized.ProjectPath == "" {
			return nil, fmt.Errorf("%w: invalid project rail placement", ErrInvalidArgument)
		}
		normalized.SectionKey = storesqlite.RailSectionKeyForProject(normalized.ProjectPath)
	default:
		return nil, fmt.Errorf("%w: invalid rail placement kind", ErrInvalidArgument)
	}
	return normalized, nil
}

func railPlacementMatchesSession(placement *RailPlacement, session storesqlite.Session) bool {
	if placement == nil {
		return true
	}
	return strings.TrimSpace(session.RailSectionKind) == string(placement.Kind) &&
		storesqlite.NormalizeProjectPath(session.RailProjectPath) ==
			storesqlite.NormalizeProjectPath(placement.ProjectPath) &&
		storesqlite.NormalizeRailSectionKey(session.RailSectionKey) ==
			storesqlite.NormalizeRailSectionKey(placement.SectionKey)
}

// GetSessionWithRailPlacement reads one canonical Session only when its
// immutable rail identity matches the caller's Host-normalized placement.
// Recovery consumers use this boundary instead of reproducing rail
// normalization or comparing canonical storage fields outside Agent Host.
func (h *Host) GetSessionWithRailPlacement(
	ctx context.Context,
	ref SessionRef,
	placement *RailPlacement,
) (GetSessionResult, error) {
	normalized, err := normalizeRailPlacement(placement)
	if err != nil {
		return GetSessionResult{}, err
	}
	if normalized == nil {
		return GetSessionResult{}, ErrInvalidArgument
	}
	result, err := h.GetSession(ctx, ref)
	if err != nil {
		return GetSessionResult{}, err
	}
	if !railPlacementMatchesSession(normalized, result.Canonical) {
		return GetSessionResult{}, ErrRailPlacementConflict
	}
	return result, nil
}
