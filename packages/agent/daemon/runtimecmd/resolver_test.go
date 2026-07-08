package runtimecmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolverFindsKnownNodeGlobalBin(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".nvm", "versions", "node", "v24.12.0", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	binaryPath := filepath.Join(binDir, "codex-acp")
	writeExecutable(t, binaryPath)

	resolver := Resolver{
		Environ: func() []string {
			return []string{"PATH=/usr/bin:/bin"}
		},
		HomeDir: func() (string, error) {
			return home, nil
		},
		LookPath: func(string) (string, error) {
			return "", os.ErrNotExist
		},
	}

	env := resolver.Env(nil)
	if got := resolver.Resolve("codex-acp", env); got != binaryPath {
		t.Fatalf("Resolve() = %q, want %q", got, binaryPath)
	}
	if got := resolver.ResolveBinary([]string{"codex-acp"}, nil); got != binaryPath {
		t.Fatalf("ResolveBinary() = %q, want %q", got, binaryPath)
	}
}

func TestResolverPrefersNewestNVMNodeBin(t *testing.T) {
	home := t.TempDir()
	oldBinDir := filepath.Join(home, ".nvm", "versions", "node", "v20.19.4", "bin")
	newBinDir := filepath.Join(home, ".nvm", "versions", "node", "v24.16.0", "bin")
	for _, dir := range []string{oldBinDir, newBinDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir bin dir: %v", err)
		}
		writeExecutable(t, filepath.Join(dir, "codex"))
	}

	resolver := Resolver{
		Environ: func() []string {
			return []string{"PATH=/usr/bin:/bin"}
		},
		HomeDir: func() (string, error) {
			return home, nil
		},
		LookPath: func(string) (string, error) {
			return "", os.ErrNotExist
		},
	}

	env := resolver.Env(nil)
	want := filepath.Join(newBinDir, "codex")
	if got := resolver.Resolve("codex", env); got != want {
		t.Fatalf("Resolve() = %q, want newest NVM codex %q", got, want)
	}
}

func TestResolverPrefersExistingPathOverScannedNVMFallback(t *testing.T) {
	home := t.TempDir()
	activeBinDir := filepath.Join(home, ".nvm", "versions", "node", "v20.19.4", "bin")
	newerBinDir := filepath.Join(home, ".nvm", "versions", "node", "v24.16.0", "bin")
	for _, dir := range []string{activeBinDir, newerBinDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir bin dir: %v", err)
		}
		writeExecutable(t, filepath.Join(dir, "codex"))
	}

	resolver := Resolver{
		Environ: func() []string {
			return []string{
				"PATH=" + activeBinDir + string(os.PathListSeparator) + "/usr/bin:/bin",
			}
		},
		HomeDir: func() (string, error) {
			return home, nil
		},
		LookPath: func(string) (string, error) {
			return "", os.ErrNotExist
		},
	}

	env := resolver.Env(nil)
	want := filepath.Join(activeBinDir, "codex")
	if got := resolver.Resolve("codex", env); got != want {
		t.Fatalf("Resolve() = %q, want active PATH codex %q", got, want)
	}
}

func TestResolverFindsTuttiBinFallback(t *testing.T) {
	home := t.TempDir()
	tuttiBinDir := filepath.Join(home, ".tutti", "bin")
	if err := os.MkdirAll(tuttiBinDir, 0o755); err != nil {
		t.Fatalf("mkdir tutti bin dir: %v", err)
	}
	tuttiPath := filepath.Join(tuttiBinDir, "tutti")
	writeExecutable(t, tuttiPath)

	resolver := Resolver{
		Environ: func() []string {
			return []string{"PATH=/usr/bin:/bin"}
		},
		HomeDir: func() (string, error) {
			return home, nil
		},
		LookPath: func(string) (string, error) {
			return "", os.ErrNotExist
		},
	}

	env := resolver.Env(nil)
	if got := resolver.Resolve("tutti", env); got != tuttiPath {
		t.Fatalf("Resolve() = %q, want %q", got, tuttiPath)
	}
	if got := resolver.ResolveBinary([]string{"tutti"}, nil); got != tuttiPath {
		t.Fatalf("ResolveBinary() = %q, want %q", got, tuttiPath)
	}
}

func TestResolverFindsOpenCodeBinFallback(t *testing.T) {
	home := t.TempDir()
	opencodeBinDir := filepath.Join(home, ".opencode", "bin")
	if err := os.MkdirAll(opencodeBinDir, 0o755); err != nil {
		t.Fatalf("mkdir opencode bin dir: %v", err)
	}
	opencodePath := filepath.Join(opencodeBinDir, "opencode")
	writeExecutable(t, opencodePath)

	resolver := Resolver{
		Environ: func() []string {
			return []string{"PATH=/usr/bin:/bin"}
		},
		HomeDir: func() (string, error) {
			return home, nil
		},
		LookPath: func(string) (string, error) {
			return "", os.ErrNotExist
		},
	}

	env := resolver.Env(nil)
	if got := resolver.Resolve("opencode", env); got != opencodePath {
		t.Fatalf("Resolve() = %q, want %q", got, opencodePath)
	}
	if got := resolver.ResolveBinary([]string{"opencode"}, nil); got != opencodePath {
		t.Fatalf("ResolveBinary() = %q, want %q", got, opencodePath)
	}
}

func TestResolverFindsFnmNodeBin(t *testing.T) {
	home := t.TempDir()
	fnmDir := filepath.Join(home, "custom-fnm")
	binDir := filepath.Join(fnmDir, "node-versions", "v24.12.0", "installation", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	nodePath := filepath.Join(binDir, "node")
	writeExecutable(t, nodePath)

	resolver := Resolver{
		Environ: func() []string {
			return []string{
				"PATH=/usr/bin:/bin",
				"FNM_DIR=" + fnmDir,
			}
		},
		HomeDir: func() (string, error) {
			return home, nil
		},
		LookPath: func(string) (string, error) {
			return "", os.ErrNotExist
		},
	}

	env := resolver.Env(nil)
	if got := resolver.Resolve("node", env); got != nodePath {
		t.Fatalf("Resolve() = %q, want %q", got, nodePath)
	}
}

func TestResolverPrefersFnmNodeBinOverExistingPathNode(t *testing.T) {
	home := t.TempDir()
	fnmDir := filepath.Join(home, "custom-fnm")
	fnmBinDir := filepath.Join(fnmDir, "node-versions", "v24.12.0", "installation", "bin")
	existingBinDir := filepath.Join(home, "existing", "bin")
	for _, dir := range []string{fnmBinDir, existingBinDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir bin dir: %v", err)
		}
	}
	fnmNodePath := filepath.Join(fnmBinDir, "node")
	writeExecutable(t, fnmNodePath)
	writeExecutable(t, filepath.Join(existingBinDir, "node"))

	resolver := Resolver{
		Environ: func() []string {
			return []string{
				"PATH=" + existingBinDir + string(os.PathListSeparator) + "/usr/bin:/bin",
				"FNM_DIR=" + fnmDir,
			}
		},
		HomeDir: func() (string, error) {
			return home, nil
		},
		LookPath: func(string) (string, error) {
			return "", os.ErrNotExist
		},
	}

	env := resolver.Env(nil)
	if got := resolver.Resolve("node", env); got != fnmNodePath {
		t.Fatalf("Resolve() = %q, want %q", got, fnmNodePath)
	}
}

func TestResolverReplacesPathEnv(t *testing.T) {
	resolver := Resolver{
		Environ: func() []string {
			return []string{"PATH=/first", "OTHER=value"}
		},
		HomeDir: func() (string, error) {
			return "", os.ErrNotExist
		},
	}

	env := resolver.Env([]string{"PATH=/override:/first"})
	pathCount := 0
	pathValue := ""
	for _, item := range env {
		key, value, ok := strings.Cut(item, "=")
		if ok && key == "PATH" {
			pathCount++
			pathValue = value
		}
	}
	if pathCount != 1 {
		t.Fatalf("PATH entry count = %d, want 1 in %#v", pathCount, env)
	}
	if !strings.HasPrefix(pathValue, "/override") {
		t.Fatalf("PATH = %q, want override prefix", pathValue)
	}
}

func TestResolverMergesMultiplePathOverrides(t *testing.T) {
	resolver := Resolver{
		Environ: func() []string {
			return []string{"PATH=/usr/bin:/bin"}
		},
		HomeDir: func() (string, error) {
			return "", os.ErrNotExist
		},
	}

	env := resolver.Env([]string{
		"PATH=/state/bin:/usr/bin:/bin",
		"PATH=/managed/node/bin:/usr/bin:/bin",
	})
	pathCount := 0
	pathValue := ""
	for _, item := range env {
		key, value, ok := strings.Cut(item, "=")
		if ok && key == "PATH" {
			pathCount++
			pathValue = value
		}
	}
	if pathCount != 1 {
		t.Fatalf("PATH entry count = %d, want 1 in %#v", pathCount, env)
	}
	pathDirs := filepath.SplitList(pathValue)
	if len(pathDirs) < 4 ||
		pathDirs[0] != "/managed/node/bin" ||
		pathDirs[1] != "/state/bin" ||
		pathDirs[2] != "/usr/bin" ||
		pathDirs[3] != "/bin" {
		t.Fatalf("PATH = %q, want override prefixes before inherited base path", pathValue)
	}
}

func TestResolverEnvStripsClaudeCodeNestingGuards(t *testing.T) {
	resolver := Resolver{
		Environ: func() []string {
			return []string{
				"PATH=/usr/bin",
				"CLAUDECODE=1",
				"CLAUDE_CODE_ENTRYPOINT=claude-desktop",
				"CLAUDE_CODE_SESSION_ID=abc",
				"CLAUDE_CODE_CHILD_SESSION=1",
				"CLAUDE_CODE_OAUTH_SCOPES=keep-me",
				"OTHER=value",
			}
		},
		HomeDir: func() (string, error) {
			return "", os.ErrNotExist
		},
	}

	env := resolver.Env(nil)
	for _, item := range env {
		key, _, _ := strings.Cut(item, "=")
		switch key {
		case "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION":
			t.Fatalf("nesting guard %q should be stripped, got %#v", key, env)
		}
	}
	if value, ok := envValueFrom(env, "CLAUDE_CODE_OAUTH_SCOPES"); !ok || value != "keep-me" {
		t.Fatalf("unrelated CLAUDE_CODE_* var was dropped: %#v", env)
	}
	if value, ok := envValueFrom(env, "OTHER"); !ok || value != "value" {
		t.Fatalf("unrelated var was dropped: %#v", env)
	}
}

func TestResolverUserBinInstallDirsPrefersPathEntriesThenFallbacks(t *testing.T) {
	home := t.TempDir()
	pathDir := filepath.Join(home, "custom-bin")
	resolver := Resolver{
		Environ: func() []string {
			return []string{"PATH=" + pathDir + string(os.PathListSeparator) + "/usr/bin"}
		},
		HomeDir: func() (string, error) {
			return home, nil
		},
	}

	dirs := resolver.UserBinInstallDirs(nil)
	if len(dirs) < 4 {
		t.Fatalf("len(dirs) = %d, want at least 4; dirs=%#v", len(dirs), dirs)
	}
	if dirs[0] != pathDir {
		t.Fatalf("dirs[0] = %q, want %q", dirs[0], pathDir)
	}
	if dirs[1] != "/usr/bin" {
		t.Fatalf("dirs[1] = %q, want /usr/bin", dirs[1])
	}
	if dirs[2] != filepath.Join(home, ".local", "bin") {
		t.Fatalf("dirs[2] = %q, want fallback ~/.local/bin", dirs[2])
	}
	if dirs[3] != filepath.Join(home, "bin") {
		t.Fatalf("dirs[3] = %q, want fallback ~/bin", dirs[3])
	}
}

func writeExecutable(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write executable %s: %v", path, err)
	}
}
