package runtimeprep

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const rtkInstructionsMarkdown = `# RTK - Rust Token Killer

RTK is a token-optimized CLI proxy for shell commands.

## Rule

Always prefix supported shell commands with ` + "`rtk`" + `.

Examples:

` + "```bash" + `
rtk git status
rtk go test ./...
rtk pnpm test
rtk pytest -q
` + "```" + `

Use ` + "`rtk proxy <cmd>`" + ` when raw output is required. Use ` + "`rtk gain`" + ` or
` + "`rtk gain --history`" + ` to inspect Session-local token savings.
`

type sessionRTKRuntime struct {
	Executable          string
	Instructions        string
	Env                 []string
	ExecutableCreated   bool
	InstructionsCreated bool
}

// prepareSessionRTK copies an already available RTK executable and the
// provider-neutral RTK.md instructions into the exact Session runtime. It
// deliberately does not run a package manager or upstream installer.
func prepareSessionRTK(runtimeRoot string, resolveSource func() (string, error)) (sessionRTKRuntime, error) {
	rtkRoot := filepath.Join(runtimeRoot, "rtk")
	binDir := filepath.Join(rtkRoot, "bin")
	dataDir := filepath.Join(rtkRoot, "data")
	teeDir := filepath.Join(rtkRoot, "tee")
	for _, dir := range []string{binDir, dataDir, teeDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return sessionRTKRuntime{}, fmt.Errorf("create session RTK directory: %w", err)
		}
	}

	target := filepath.Join(binDir, rtkExecutableName())
	executableCreated := false
	if info, statErr := os.Stat(target); statErr == nil {
		if !info.Mode().IsRegular() {
			return sessionRTKRuntime{}, fmt.Errorf("session rtk executable is not a regular file: %s", target)
		}
		// A regular target preserves the launch-time RTK version on resume.
	} else if !os.IsNotExist(statErr) {
		return sessionRTKRuntime{}, fmt.Errorf("inspect session RTK executable: %w", statErr)
	} else {
		source, err := resolveSource()
		if err != nil {
			return sessionRTKRuntime{}, err
		}
		source = filepath.Clean(strings.TrimSpace(source))
		if source == "." || source == "" {
			return sessionRTKRuntime{}, errors.New("tutti-managed rtk executable path is empty")
		}
		source, err = filepath.EvalSymlinks(source)
		if err != nil {
			return sessionRTKRuntime{}, fmt.Errorf("resolve rtk executable: %w", err)
		}
		info, err := os.Stat(source)
		if err != nil {
			return sessionRTKRuntime{}, fmt.Errorf("inspect rtk executable: %w", err)
		}
		if !info.Mode().IsRegular() {
			return sessionRTKRuntime{}, fmt.Errorf("rtk executable is not a regular file: %s", source)
		}
		if err := copyFile(source, target, 0o700); err != nil {
			return sessionRTKRuntime{}, fmt.Errorf("copy RTK into session runtime: %w", err)
		}
		executableCreated = true
	}

	instructionsPath := filepath.Join(rtkRoot, "RTK.md")
	_, statErr := os.Stat(instructionsPath)
	instructionsCreated := os.IsNotExist(statErr)
	if statErr != nil && !instructionsCreated {
		return sessionRTKRuntime{}, fmt.Errorf("inspect session RTK instructions: %w", statErr)
	}
	if err := os.WriteFile(instructionsPath, []byte(rtkInstructionsMarkdown), 0o600); err != nil {
		return sessionRTKRuntime{}, fmt.Errorf("write session RTK instructions: %w", err)
	}
	return sessionRTKRuntime{
		Executable:          target,
		Instructions:        instructionsPath,
		ExecutableCreated:   executableCreated,
		InstructionsCreated: instructionsCreated,
		Env: []string{
			"RTK_DB_PATH=" + filepath.Join(dataDir, "usage.db"),
			"RTK_TEE_DIR=" + teeDir,
			"RTK_TELEMETRY_DISABLED=1",
		},
	}, nil
}

func rtkExecutableName() string {
	if runtime.GOOS == "windows" {
		return "rtk.exe"
	}
	return "rtk"
}

// ensureRTKInstructionsReferenceFirst mirrors RTK's native Codex integration:
// the provider instruction file starts with an absolute @RTK.md reference.
// The complete RTK policy remains inline as a compatibility fallback for
// providers or models that do not resolve instruction-file references.
func ensureRTKInstructionsReferenceFirst(instructionsPath string, input PrepareInput) error {
	rtkPath := strings.TrimSpace(input.rtkInstructionsPath)
	if !input.RTKSaverMode || rtkPath == "" {
		return nil
	}
	content, err := os.ReadFile(instructionsPath)
	if err != nil {
		return fmt.Errorf("read provider instructions for RTK reference: %w", err)
	}
	reference := "@" + rtkPath
	newline := "\n"
	if strings.Contains(string(content), "\r\n") {
		newline = "\r\n"
	}
	lines := strings.Split(strings.ReplaceAll(string(content), "\r\n", "\n"), "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.TrimSpace(line) != reference {
			kept = append(kept, line)
		}
	}
	body := strings.TrimLeft(strings.Join(kept, newline), "\r\n")
	next := reference + newline
	if body != "" {
		next += newline + body
	}
	if err := os.WriteFile(instructionsPath, []byte(next), 0o644); err != nil {
		return fmt.Errorf("write provider RTK instruction reference: %w", err)
	}
	return nil
}
