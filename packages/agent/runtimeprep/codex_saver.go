package runtimeprep

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const codexRTKInitTimeout = 15 * time.Second

type codexRTKRuntime struct {
	Executable string
	Env        []string
	Created    bool
}

// installCodexRTKRuntime copies an already available RTK executable into the
// exact Session runtime. It deliberately does not run a package manager or an
// upstream installer: enabling one Session must never mutate a user-global
// toolchain or make RTK visible to unrelated Agent processes.
func installCodexRTKRuntime(runtimeRoot string) (codexRTKRuntime, error) {
	rtkRoot := filepath.Join(runtimeRoot, "rtk")
	binDir := filepath.Join(rtkRoot, "bin")
	dataDir := filepath.Join(rtkRoot, "data")
	teeDir := filepath.Join(rtkRoot, "tee")
	for _, dir := range []string{binDir, dataDir, teeDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return codexRTKRuntime{}, fmt.Errorf("create Session RTK directory: %w", err)
		}
	}
	target := filepath.Join(binDir, codexRTKExecutableName())
	if info, err := os.Stat(target); err == nil && info.Mode().IsRegular() {
		return newCodexRTKRuntime(rtkRoot, binDir, target, false), nil
	} else if err != nil && !os.IsNotExist(err) {
		return codexRTKRuntime{}, fmt.Errorf("inspect Session RTK executable: %w", err)
	}

	source, err := exec.LookPath(codexRTKExecutableName())
	if err != nil {
		return codexRTKRuntime{}, fmt.Errorf(
			"codex RTK saver mode requires an existing rtk executable: %w",
			err,
		)
	}
	source, err = filepath.EvalSymlinks(source)
	if err != nil {
		return codexRTKRuntime{}, fmt.Errorf("resolve RTK executable: %w", err)
	}
	info, err := os.Stat(source)
	if err != nil {
		return codexRTKRuntime{}, fmt.Errorf("inspect RTK executable: %w", err)
	}
	if !info.Mode().IsRegular() {
		return codexRTKRuntime{}, fmt.Errorf("RTK executable is not a regular file: %s", source)
	}
	if err := copyFile(source, target, 0o700); err != nil {
		return codexRTKRuntime{}, fmt.Errorf("copy RTK into Session runtime: %w", err)
	}
	return newCodexRTKRuntime(rtkRoot, binDir, target, true), nil
}

func newCodexRTKRuntime(rtkRoot string, binDir string, executable string, created bool) codexRTKRuntime {
	return codexRTKRuntime{
		Executable: executable,
		Created:    created,
		Env: []string{
			"PATH=" + binDir + string(os.PathListSeparator) + os.Getenv("PATH"),
			"RTK_DB_PATH=" + filepath.Join(rtkRoot, "data", "usage.db"),
			"RTK_TEE_DIR=" + filepath.Join(rtkRoot, "tee"),
			"RTK_TELEMETRY_DISABLED=1",
		},
	}
}

// initializeCodexRTK lets the Session-private RTK binary generate the
// version-matched RTK.md and its @RTK.md AGENTS.md reference. HOME and RTK's
// writable data paths remain inside the Session runtime for the entire call.
func initializeCodexRTK(parent context.Context, runtimeRoot string, codexHome string, rtkRuntime codexRTKRuntime) (string, error) {
	ctx, cancel := context.WithTimeout(parent, codexRTKInitTimeout)
	defer cancel()
	rtkHome := filepath.Join(runtimeRoot, "rtk", "home")
	if err := os.MkdirAll(rtkHome, 0o700); err != nil {
		return "", fmt.Errorf("create Session RTK home: %w", err)
	}
	command := exec.CommandContext(ctx, rtkRuntime.Executable, "init", "--codex")
	command.Dir = codexHome
	command.Env = append(os.Environ(), "HOME="+rtkHome)
	command.Env = append(command.Env, rtkRuntime.Env...)
	output, err := command.CombinedOutput()
	if err != nil {
		if ctx.Err() != nil {
			return "", fmt.Errorf("initialize Session RTK instructions: %w", ctx.Err())
		}
		return "", fmt.Errorf(
			"initialize Session RTK instructions: %w: %s",
			err,
			strings.TrimSpace(string(output)),
		)
	}
	instructionsPath := filepath.Join(codexHome, "RTK.md")
	if info, err := os.Stat(instructionsPath); err != nil || !info.Mode().IsRegular() {
		if err == nil {
			err = fmt.Errorf("not a regular file")
		}
		return "", fmt.Errorf("verify Session RTK instructions: %w", err)
	}
	return instructionsPath, nil
}

func codexRTKExecutableName() string {
	if runtime.GOOS == "windows" {
		return "rtk.exe"
	}
	return "rtk"
}
