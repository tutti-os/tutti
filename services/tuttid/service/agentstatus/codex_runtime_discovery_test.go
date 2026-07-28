package agentstatus

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

func TestDiscoverCodexRuntimeCandidatesEnumeratesAllManagerBinsAfterPathMatch(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is Unix-only")
	}
	home := t.TempDir()
	managerBin := filepath.Join(home, "manager-bin")
	pathBin := filepath.Join(home, "path-bin")
	bunBin := filepath.Join(home, "bun-global-bin")
	pnpmBin := filepath.Join(home, "pnpm-global-bin")
	npmPrefix := filepath.Join(home, "npm-prefix")
	brewPrefix := filepath.Join(home, "brew-prefix")

	pathCodex := filepath.Join(pathBin, "codex")
	bunCodex := filepath.Join(bunBin, "codex")
	pnpmCodex := filepath.Join(pnpmBin, "codex")
	npmCodex := filepath.Join(npmPrefix, "bin", "codex")
	brewCodex := filepath.Join(brewPrefix, "bin", "codex")
	for _, path := range []string{pathCodex, bunCodex, pnpmCodex, npmCodex, brewCodex} {
		writeExecutable(t, path, "#!/bin/sh\nexit 0\n")
	}
	writeExecutable(t, filepath.Join(managerBin, "bun"), "#!/bin/sh\nif [ \"$1\" = pm ] && [ \"$2\" = bin ] && [ \"$3\" = -g ]; then echo \""+bunBin+"\"; fi\n")
	writeExecutable(t, filepath.Join(managerBin, "pnpm"), "#!/bin/sh\nif [ \"$1\" = bin ] && [ \"$2\" = -g ]; then echo \""+pnpmBin+"\"; fi\n")
	writeExecutable(t, filepath.Join(managerBin, "npm"), "#!/bin/sh\nif [ \"$1\" = prefix ] && [ \"$2\" = -g ]; then echo \""+npmPrefix+"\"; fi\n")
	writeExecutable(t, filepath.Join(managerBin, "brew"), "#!/bin/sh\nif [ \"$1\" = --prefix ]; then echo \""+brewPrefix+"\"; fi\n")

	service := probeTestService(home)
	service.Environ = func() []string {
		return []string{"PATH=" + managerBin + string(os.PathListSeparator) + pathBin + string(os.PathListSeparator) + "/usr/bin:/bin"}
	}
	candidates := service.discoverCodexRuntimeCandidates(context.Background(), ProviderSpec{Provider: "codex"})

	if got, want := candidateLaunchers(candidates), []string{pathCodex, bunCodex, pnpmCodex, npmCodex, brewCodex}; !reflect.DeepEqual(got, want) {
		t.Fatalf("launchers = %#v, want %#v", got, want)
	}
	for index, source := range []codexRuntimeCandidateSource{
		codexRuntimeCandidateSourcePath,
		codexRuntimeCandidateSourceBunGlobal,
		codexRuntimeCandidateSourcePNPMGlobal,
		codexRuntimeCandidateSourceNPMGlobal,
		codexRuntimeCandidateSourceHomebrew,
	} {
		if got := candidates[index].Sources; !reflect.DeepEqual(got, []codexRuntimeCandidateSource{source}) {
			t.Fatalf("candidate %d sources = %#v, want %#v", index, got, []codexRuntimeCandidateSource{source})
		}
	}
}

func TestDiscoverCodexRuntimeCandidatesDeduplicatesLauncherAliases(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink fixture is Unix-only")
	}
	home := t.TempDir()
	target := filepath.Join(home, "package", "bin", "codex")
	aliasDir := filepath.Join(home, "alias-bin")
	alias := filepath.Join(aliasDir, "codex")
	writeExecutable(t, target, "#!/bin/sh\nexit 0\n")
	if err := os.MkdirAll(aliasDir, 0o755); err != nil {
		t.Fatalf("mkdir alias dir: %v", err)
	}
	if err := os.Symlink(target, alias); err != nil {
		t.Fatalf("create launcher alias: %v", err)
	}

	service := probeTestService(home)
	service.Environ = func() []string {
		return []string{"PATH=" + filepath.Dir(target) + string(os.PathListSeparator) + aliasDir}
	}
	candidates := service.discoverCodexRuntimeCandidates(context.Background(), ProviderSpec{Provider: "codex"})
	if len(candidates) != 1 {
		t.Fatalf("candidate count = %d, want one: %#v", len(candidates), candidates)
	}
	realTarget, err := filepath.EvalSymlinks(target)
	if err != nil {
		t.Fatalf("resolve target: %v", err)
	}
	if candidates[0].LauncherPath != target || candidates[0].RealPath != realTarget {
		t.Fatalf("candidate = %#v, want launcher %q and real path %q", candidates[0], target, realTarget)
	}
}

func TestCodexRuntimeCandidateCollectorDeduplicatesPackageRoots(t *testing.T) {
	home := t.TempDir()
	pkgRoot := filepath.Join(home, "node_modules", "@openai", "codex")
	writePackageManifest(t, pkgRoot, "@openai/codex", "0.142.0")
	first := filepath.Join(pkgRoot, "bin", "codex")
	second := filepath.Join(pkgRoot, "alternate", "codex")
	writeExecutable(t, first, "#!/bin/sh\nexit 0\n")
	writeExecutable(t, second, "#!/bin/sh\nexit 0\n")

	collector := codexRuntimeCandidateCollector{}
	collector.add(first, codexRuntimeCandidateSourcePath)
	collector.add(second, codexRuntimeCandidateSourceBunGlobal)
	if len(collector.candidates) != 1 {
		t.Fatalf("candidate count = %d, want one: %#v", len(collector.candidates), collector.candidates)
	}
	candidate := collector.candidates[0]
	realPkgRoot, err := filepath.EvalSymlinks(pkgRoot)
	if err != nil {
		t.Fatalf("resolve package root: %v", err)
	}
	if candidate.PackageRoot != realPkgRoot {
		t.Fatalf("package root = %q, want %q", candidate.PackageRoot, realPkgRoot)
	}
	if got, want := candidate.Sources, []codexRuntimeCandidateSource{codexRuntimeCandidateSourcePath, codexRuntimeCandidateSourceBunGlobal}; !reflect.DeepEqual(got, want) {
		t.Fatalf("sources = %#v, want %#v", got, want)
	}
}

func candidateLaunchers(candidates []codexRuntimeCandidate) []string {
	result := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		result = append(result, candidate.LauncherPath)
	}
	return result
}
