package workspace

import (
	"os"
	"path/filepath"
	"strings"

	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func (s *AppFactoryService) store() workspacedata.AppFactoryStore {
	return s.Store
}

func (s *AppFactoryService) appStore() workspacedata.AppStore {
	return s.AppStore
}

func (s *AppFactoryService) appCenter() *AppCenterService {
	return s.AppCenter
}

func (s *AppFactoryService) runner() *AppRunner {
	if s.Runner == nil {
		s.Runner = &AppRunner{}
	}
	return s.Runner
}

func (s *AppFactoryService) stateDir() string {
	if strings.TrimSpace(s.StateDir) != "" {
		return s.StateDir
	}
	if value := strings.TrimSpace(os.Getenv("TUTTI_STATE_DIR")); value != "" {
		return value
	}
	return tuttitypes.DefaultStateDir()
}

func (s *AppFactoryService) appFactoryComposerDraftDir(workspaceID string) string {
	return filepath.Join(
		s.stateDir(),
		"apps",
		"factory",
		"composer",
		safeAppPathSegment(workspaceID),
		"draft",
	)
}
