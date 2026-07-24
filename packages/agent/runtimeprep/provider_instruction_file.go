package runtimeprep

import (
	"context"
	"path/filepath"
	"strings"
)

type InstructionFilePreparer struct {
	ProviderID string
	FileName   string
}

func (p InstructionFilePreparer) Provider() string {
	return strings.TrimSpace(p.ProviderID)
}

func (p InstructionFilePreparer) Prepare(_ context.Context, input ProviderPrepareInput) (ProviderPrepareResult, error) {
	fileName := strings.TrimSpace(p.FileName)
	if fileName == "" {
		fileName = "AGENTS.md"
	}
	path := filepath.Join(input.Cwd, fileName)
	policy, err := tuttiCLIPolicy(input.PrepareInput)
	if err != nil {
		return ProviderPrepareResult{}, err
	}
	writeResult, err := input.Store.WriteManagedBlock(path, policy)
	if err != nil {
		return ProviderPrepareResult{}, err
	}
	if input.Manifest != nil {
		input.Manifest.RecordManagedFile(path, "provider-instructions", writeResult.Created)
	}
	skillRoot := providerSkillRoot(input.Cwd, input.Provider)
	if skillRoot != "" {
		skillPaths, err := installProviderNativeSkills(skillRoot, input.PrepareInput)
		if err != nil {
			return ProviderPrepareResult{}, err
		}
		if input.Manifest != nil {
			for _, skillPath := range skillPaths {
				input.Manifest.RecordManagedFile(skillPath, "provider-skill", true)
			}
		}
	}
	return ProviderPrepareResult{
		Cwd: input.Cwd,
	}, nil
}
