package computer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// computerPermissionCheckTimeout bounds the read-only cua-driver status probe.
const computerPermissionCheckTimeout = 10 * time.Second

// ErrNotInstalled is returned when cua-driver is not found on PATH or at the
// configured entry path.
var ErrNotInstalled = errors.New(
	"cua-driver is not installed; install it from https://github.com/trycua/cua or set TUTTI_COMPUTER_MCP_ENTRY_PATH")

// ErrPermissionsMissing is returned when cua-driver is installed but cannot
// confirm the macOS permissions needed for desktop control.
var ErrPermissionsMissing = errors.New(
	"cua-driver needs Accessibility and Screen Recording permissions; grant them in Tutti settings before using computer control")

// CheckReady checks that cua-driver is reachable before advertising or starting
// computer-use. Permission status is checked with cua-driver's read-only status
// command so starting an agent cannot unexpectedly trigger multiple macOS
// authorization prompts.
func CheckReady() error {
	if runtime.GOOS != "darwin" {
		return errors.New("computer use requires macOS")
	}
	// The status probe must be bounded: a wedged cua-driver would otherwise
	// hang every agent-startup and capability-advertising path forever.
	ctx, cancel := context.WithTimeout(context.Background(), computerPermissionCheckTimeout)
	defer cancel()
	command := resolveComputerMCPCommand(ctx)
	if len(command) == 0 {
		return ErrNotInstalled
	}
	if _, err := exec.LookPath(command[0]); err != nil {
		return ErrNotInstalled
	}
	return checkComputerPermissions(ctx, command[0])
}

func validateComputerReady() error {
	return CheckReady()
}

type computerPermissionStatus struct {
	Accessibility             *bool `json:"accessibility"`
	ScreenRecording           *bool `json:"screen_recording"`
	ScreenRecordingCapturable *bool `json:"screen_recording_capturable"`
}

func checkComputerPermissions(ctx context.Context, executable string) error {
	output, err := exec.CommandContext(ctx, executable, "permissions", "status", "--json").CombinedOutput()
	if err != nil {
		return fmt.Errorf("cua-driver permissions status failed: %w%s", err, stderrSuffix(output))
	}
	status, err := parseComputerPermissionStatus(output)
	if err != nil {
		return err
	}
	if issues := computerPermissionIssues(status); len(issues) > 0 {
		return fmt.Errorf("%w: %s", ErrPermissionsMissing, strings.Join(issues, ", "))
	}
	return nil
}

func parseComputerPermissionStatus(output []byte) (computerPermissionStatus, error) {
	trimmed := bytes.TrimSpace(output)
	if len(trimmed) == 0 {
		return computerPermissionStatus{}, fmt.Errorf("cua-driver permissions status returned no output")
	}

	payload := trimmed
	if !bytes.HasPrefix(payload, []byte("{")) {
		start := bytes.IndexByte(payload, '{')
		end := bytes.LastIndexByte(payload, '}')
		if start < 0 || end <= start {
			return computerPermissionStatus{}, fmt.Errorf("decode cua-driver permissions status: %s", truncatePermissionStatusOutput(trimmed))
		}
		payload = payload[start : end+1]
	}

	var status computerPermissionStatus
	if err := json.Unmarshal(payload, &status); err != nil {
		return computerPermissionStatus{}, fmt.Errorf("decode cua-driver permissions status: %w", err)
	}
	return status, nil
}

func computerPermissionIssues(status computerPermissionStatus) []string {
	issues := make([]string, 0, 3)
	if status.Accessibility == nil || !*status.Accessibility {
		issues = append(issues, "missing Accessibility")
	}
	if status.ScreenRecording == nil || !*status.ScreenRecording {
		issues = append(issues, "missing Screen Recording")
	} else if status.ScreenRecordingCapturable == nil || !*status.ScreenRecordingCapturable {
		issues = append(issues, "Screen Recording authorized but not capturable; restart CuaDriver and check again")
	}
	return issues
}

func stderrSuffix(output []byte) string {
	text := strings.TrimSpace(string(output))
	if text == "" {
		return ""
	}
	return ": " + truncatePermissionStatusOutput([]byte(text))
}

func truncatePermissionStatusOutput(output []byte) string {
	text := strings.TrimSpace(string(output))
	if len(text) <= 240 {
		return text
	}
	return text[:240] + "..."
}
