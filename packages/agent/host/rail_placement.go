package agenthost

import (
	"context"
	"fmt"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// RailPlacementVersion is the current Host rail-placement contract version.
const RailPlacementVersion = 1

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
	if normalized.Version != RailPlacementVersion {
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

func railPlacementFromSession(session storesqlite.Session) (*RailPlacement, error) {
	kind := RailPlacementKind(strings.TrimSpace(session.RailSectionKind))
	projectPath := strings.TrimSpace(session.RailProjectPath)
	sectionKey := storesqlite.NormalizeRailSectionKey(session.RailSectionKey)
	if kind == "" {
		switch {
		case sectionKey == "", sectionKey == storesqlite.RailSectionKeyConversations:
			kind = RailPlacementKindConversations
		case strings.HasPrefix(sectionKey, "project:"):
			kind = RailPlacementKindProject
		}
	}
	if kind == RailPlacementKindConversations && sectionKey == "" {
		sectionKey = storesqlite.RailSectionKeyConversations
	}
	if kind == RailPlacementKindProject && projectPath == "" && strings.HasPrefix(sectionKey, "project:") {
		projectPath = strings.TrimPrefix(sectionKey, "project:")
	}
	if kind == RailPlacementKindConversations && projectPath == "" {
		return normalizeRailPlacement(&RailPlacement{
			Version: RailPlacementVersion, Kind: RailPlacementKindConversations,
			SectionKey: storesqlite.RailSectionKeyConversations,
		})
	}
	return normalizeRailPlacement(&RailPlacement{
		Version:     RailPlacementVersion,
		Kind:        kind,
		ProjectPath: projectPath,
		SectionKey:  sectionKey,
	})
}

func runtimeEnvironmentForCanonicalSession(
	env []string,
	cwd string,
	session storesqlite.Session,
) ([]string, error) {
	placement, err := railPlacementFromSession(session)
	if err != nil {
		return nil, err
	}
	return withAgentRailPlacementEnvironment(env, cwd, placement)
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
