package agenthost

import (
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
		if normalized.ProjectPath != "" || normalized.SectionKey != storesqlite.RailSectionKeyConversations {
			return nil, fmt.Errorf("%w: invalid conversations rail placement", ErrInvalidArgument)
		}
	case RailPlacementKindProject:
		if normalized.ProjectPath == "" ||
			normalized.SectionKey == "" ||
			normalized.SectionKey == storesqlite.RailSectionKeyConversations {
			return nil, fmt.Errorf("%w: invalid project rail placement", ErrInvalidArgument)
		}
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
		strings.TrimSpace(session.RailSectionKey) == placement.SectionKey
}
