package workspace

import (
	"embed"
	"fmt"
	"io/fs"
	"path/filepath"

	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

//go:embed agent_workspace_app_reference/*
var agentWorkspaceAppReferenceFiles embed.FS

const agentWorkspaceAppReferenceRoot = "agent_workspace_app_reference"

func agentWorkspaceAppReferenceSkillBundle() (agentservice.SessionSkillBundle, error) {
	files := make(map[string]string)
	if err := fs.WalkDir(agentWorkspaceAppReferenceFiles, agentWorkspaceAppReferenceRoot, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		relativePath, err := filepath.Rel(agentWorkspaceAppReferenceRoot, path)
		if err != nil {
			return fmt.Errorf("resolve agent workspace app skill path: %w", err)
		}
		data, err := agentWorkspaceAppReferenceFiles.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read agent workspace app skill file: %w", err)
		}
		files[filepath.ToSlash(relativePath)] = string(data)
		return nil
	}); err != nil {
		return agentservice.SessionSkillBundle{}, err
	}
	return agentservice.SessionSkillBundle{
		Name:  "tutti-agent-workspace-app",
		Files: files,
	}, nil
}
