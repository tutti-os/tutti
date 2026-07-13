package runtimeprep

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMaterializeConfigDependencyIsIdempotentAndRecordsTarget(t *testing.T) {
	sourceRoot := t.TempDir()
	targetRoot := t.TempDir()
	source := filepath.Join(sourceRoot, "nested", "instructions.md")
	writeSidecarTestFile(t, source, "instructions\n")
	manifest := NewManifest(ManifestInput{})
	input := configDependencyMaterializeInput{
		Provider:   "codex",
		ConfigKey:  "model_instructions_file",
		RawPath:    filepath.Join("nested", "instructions.md"),
		SourceRoot: sourceRoot,
		TargetRoot: targetRoot,
		Manifest:   manifest,
	}

	if err := materializeConfigDependency(input); err != nil {
		t.Fatalf("first materialization error = %v", err)
	}
	if err := materializeConfigDependency(input); err != nil {
		t.Fatalf("second materialization error = %v", err)
	}
	target := filepath.Join(targetRoot, "nested", "instructions.md")
	content, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "instructions\n" {
		t.Fatalf("target content = %q", string(content))
	}
	if len(manifest.ManagedFiles) != 1 || manifest.ManagedFiles[0].Path != target || !manifest.ManagedFiles[0].Created {
		t.Fatalf("managed files = %#v", manifest.ManagedFiles)
	}
}

func TestMaterializeConfigDependencyKeepsAbsoluteParentPathPrivate(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "private", "missing.md")
	err := materializeConfigDependency(configDependencyMaterializeInput{
		Provider:  "codex",
		ConfigKey: "model_instructions_file",
		RawPath:   missing,
	})
	var dependencyErr *ConfigDependencyUnavailableError
	if !errors.As(err, &dependencyErr) {
		t.Fatalf("error = %T %v, want ConfigDependencyUnavailableError", err, err)
	}
	if dependencyErr.DependencyPath != "missing.md" {
		t.Fatalf("dependency path = %q, want basename", dependencyErr.DependencyPath)
	}
	if strings.Contains(err.Error(), filepath.Dir(missing)) {
		t.Fatalf("public error leaks absolute parent path: %q", err.Error())
	}
}
