package runtimeprep

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const stableSkillBundleSchemaVersion = 1

type stableSkillBundleManifest struct {
	SchemaVersion int    `json:"schemaVersion"`
	Digest        string `json:"digest"`
	Provider      string `json:"provider"`
	SkillCount    int    `json:"skillCount"`
}

type canonicalStableSkillBundle struct {
	SchemaVersion int                    `json:"schemaVersion"`
	Provider      string                 `json:"provider"`
	Skills        []canonicalStableSkill `json:"skills"`
}

type canonicalStableSkill struct {
	SkillID   string                     `json:"skillId"`
	Slug      string                     `json:"slug"`
	Directory string                     `json:"directory"`
	Files     []canonicalStableSkillFile `json:"files"`
}

type canonicalStableSkillFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type materializedStableSkill struct {
	spec      providerSkillSpec
	directory string
}

func materializeStableProviderSkills(
	storeRoot string,
	input PrepareInput,
) (string, error) {
	if input.SkipSkills {
		return "", nil
	}
	storeRoot = filepath.Clean(strings.TrimSpace(storeRoot))
	if storeRoot == "." || !filepath.IsAbs(storeRoot) {
		return "", fmt.Errorf("stable provider skill bundle root must be absolute")
	}
	specs, err := providerSkills(input)
	if err != nil {
		return "", err
	}
	canonical, materialized, err := canonicalizeStableProviderSkills(input.Provider, specs)
	if err != nil {
		return "", err
	}
	canonicalJSON, err := json.Marshal(canonical)
	if err != nil {
		return "", fmt.Errorf("encode stable provider skill bundle: %w", err)
	}
	digestBytes := sha256.Sum256(canonicalJSON)
	digest := hex.EncodeToString(digestBytes[:])
	manifest := stableSkillBundleManifest{
		SchemaVersion: stableSkillBundleSchemaVersion,
		Digest:        digest,
		Provider:      strings.TrimSpace(input.Provider),
		SkillCount:    len(materialized),
	}
	versionRoot := filepath.Join(storeRoot, fmt.Sprintf("v%d", stableSkillBundleSchemaVersion))
	bundleRoot := filepath.Join(versionRoot, digest)
	skillsRoot := filepath.Join(bundleRoot, "skills")
	if err := validateStableSkillBundle(bundleRoot, manifest, materialized); err == nil {
		return skillsRoot, nil
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.MkdirAll(versionRoot, 0o755); err != nil {
		return "", fmt.Errorf("create stable provider skill bundle store: %w", err)
	}
	temporaryRoot, err := os.MkdirTemp(versionRoot, ".tmp-"+digest+"-")
	if err != nil {
		return "", fmt.Errorf("create stable provider skill bundle temporary directory: %w", err)
	}
	defer func() { _ = os.RemoveAll(temporaryRoot) }()
	temporarySkillsRoot := filepath.Join(temporaryRoot, "skills")
	if err := os.MkdirAll(temporarySkillsRoot, 0o755); err != nil {
		return "", fmt.Errorf("create stable provider skill root: %w", err)
	}
	for _, skill := range materialized {
		if err := installProviderSkillFiles(
			filepath.Join(temporarySkillsRoot, skill.directory),
			skill.spec,
		); err != nil {
			return "", err
		}
	}
	manifestJSON, err := stableSkillBundleManifestJSON(manifest)
	if err != nil {
		return "", fmt.Errorf("encode stable provider skill bundle manifest: %w", err)
	}
	if err := os.WriteFile(
		filepath.Join(temporaryRoot, "bundle.json"),
		manifestJSON,
		0o644,
	); err != nil {
		return "", fmt.Errorf("write stable provider skill bundle manifest: %w", err)
	}
	if err := validateStableSkillBundle(temporaryRoot, manifest, materialized); err != nil {
		return "", fmt.Errorf("validate staged provider skill bundle: %w", err)
	}
	if err := os.Rename(temporaryRoot, bundleRoot); err != nil {
		if validationErr := validateStableSkillBundle(bundleRoot, manifest, materialized); validationErr == nil {
			return skillsRoot, nil
		}
		return "", fmt.Errorf("commit stable provider skill bundle: %w", err)
	}
	return skillsRoot, nil
}

func canonicalizeStableProviderSkills(
	provider string,
	specs []providerSkillSpec,
) (canonicalStableSkillBundle, []materializedStableSkill, error) {
	sorted := append([]providerSkillSpec(nil), specs...)
	sort.Slice(sorted, func(left, right int) bool {
		leftID, rightID := strings.TrimSpace(sorted[left].skillID), strings.TrimSpace(sorted[right].skillID)
		if leftID != rightID {
			return leftID < rightID
		}
		return strings.TrimSpace(sorted[left].baseName) < strings.TrimSpace(sorted[right].baseName)
	})
	canonical := canonicalStableSkillBundle{
		SchemaVersion: stableSkillBundleSchemaVersion,
		Provider:      strings.TrimSpace(provider),
		Skills:        make([]canonicalStableSkill, 0, len(sorted)),
	}
	materialized := make([]materializedStableSkill, 0, len(sorted))
	usedDirectories := make(map[string]struct{}, len(sorted))
	for _, spec := range sorted {
		directory, err := allocateStableBundleSkillDirectory(spec.baseName, usedDirectories)
		if err != nil {
			return canonicalStableSkillBundle{}, nil, err
		}
		normalizedFiles := make(map[string]string, len(spec.files))
		paths := make([]string, 0, len(spec.files))
		for filePath, content := range spec.files {
			cleanPath, err := cleanProviderSkillFilePath(filePath)
			if err != nil {
				return canonicalStableSkillBundle{}, nil, err
			}
			if _, exists := normalizedFiles[cleanPath]; exists {
				return canonicalStableSkillBundle{}, nil, fmt.Errorf(
					"provider skill %s has duplicate normalized file path %q",
					spec.skillID,
					cleanPath,
				)
			}
			normalizedFiles[cleanPath] = content
			paths = append(paths, cleanPath)
		}
		sort.Strings(paths)
		files := make([]canonicalStableSkillFile, 0, len(paths))
		for _, filePath := range paths {
			files = append(files, canonicalStableSkillFile{
				Path:    filePath,
				Content: normalizedFiles[filePath],
			})
		}
		canonical.Skills = append(canonical.Skills, canonicalStableSkill{
			SkillID:   strings.TrimSpace(spec.skillID),
			Slug:      strings.TrimSpace(spec.baseName),
			Directory: directory,
			Files:     files,
		})
		materialized = append(materialized, materializedStableSkill{
			spec:      spec,
			directory: directory,
		})
	}
	return canonical, materialized, nil
}

func allocateStableBundleSkillDirectory(
	baseName string,
	used map[string]struct{},
) (string, error) {
	baseName = strings.TrimSpace(baseName)
	if baseName == "" || baseName == "." || baseName == ".." ||
		filepath.Base(baseName) != baseName || strings.ContainsAny(baseName, `/\\`) {
		return "", fmt.Errorf("provider skill name is invalid: %q", baseName)
	}
	candidates := []string{baseName, baseName + "-tutti"}
	for index := 2; index <= 99; index++ {
		candidates = append(candidates, fmt.Sprintf("%s-tutti-%d", baseName, index))
	}
	for _, candidate := range candidates {
		if _, exists := used[candidate]; exists {
			continue
		}
		used[candidate] = struct{}{}
		return candidate, nil
	}
	return "", fmt.Errorf("allocate stable provider skill directory: exhausted names for %s", baseName)
}

func validateStableSkillBundle(
	bundleRoot string,
	wantManifest stableSkillBundleManifest,
	skills []materializedStableSkill,
) error {
	info, err := os.Stat(bundleRoot)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("stable provider skill bundle is not a directory: %s", bundleRoot)
	}
	manifestBytes, err := os.ReadFile(filepath.Join(bundleRoot, "bundle.json"))
	if err != nil {
		return fmt.Errorf("read stable provider skill bundle manifest: %w", err)
	}
	var manifest stableSkillBundleManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return fmt.Errorf("decode stable provider skill bundle manifest: %w", err)
	}
	if manifest != wantManifest {
		return fmt.Errorf("stable provider skill bundle manifest does not match digest")
	}
	wantManifestBytes, err := stableSkillBundleManifestJSON(wantManifest)
	if err != nil {
		return err
	}
	wantFiles := map[string]string{"bundle.json": string(wantManifestBytes)}
	wantDirectories := map[string]struct{}{".": {}, "skills": {}}
	for _, skill := range skills {
		directory := filepath.ToSlash(filepath.Join("skills", skill.directory))
		wantDirectories[directory] = struct{}{}
		wantFiles[filepath.ToSlash(filepath.Join(directory, ".tutti-managed-skill"))] =
			skill.spec.skillID + "\n"
		for filePath, content := range skill.spec.files {
			cleanPath, err := cleanProviderSkillFilePath(filePath)
			if err != nil {
				return err
			}
			relative := filepath.ToSlash(filepath.Join(directory, filepath.FromSlash(cleanPath)))
			wantFiles[relative] = content
			for parent := filepath.ToSlash(filepath.Dir(relative)); parent != "."; parent = filepath.ToSlash(filepath.Dir(parent)) {
				wantDirectories[parent] = struct{}{}
			}
		}
	}
	seenFiles := make(map[string]struct{}, len(wantFiles))
	err = filepath.WalkDir(bundleRoot, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(bundleRoot, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("stable provider skill bundle contains symlink: %s", relative)
		}
		if entry.IsDir() {
			if _, exists := wantDirectories[relative]; !exists {
				return fmt.Errorf("stable provider skill bundle contains unexpected directory: %s", relative)
			}
			return nil
		}
		want, exists := wantFiles[relative]
		if !exists {
			return fmt.Errorf("stable provider skill bundle contains unexpected file: %s", relative)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if string(content) != want {
			return fmt.Errorf("stable provider skill bundle file does not match digest: %s", relative)
		}
		seenFiles[relative] = struct{}{}
		return nil
	})
	if err != nil {
		return err
	}
	if len(seenFiles) != len(wantFiles) {
		return fmt.Errorf("stable provider skill bundle is incomplete")
	}
	return nil
}

func stableSkillBundleManifestJSON(manifest stableSkillBundleManifest) ([]byte, error) {
	encoded, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode stable provider skill bundle manifest: %w", err)
	}
	return append(encoded, '\n'), nil
}
