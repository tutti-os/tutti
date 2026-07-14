package agentstatus

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

const (
	npmGlobalInstallLockPollInterval = 200 * time.Millisecond
	npmGlobalInstallLockRecoverRetry = 150 * time.Millisecond
)

type installCommandLock struct {
	command       string
	lockPath      string
	now           func() time.Time
	pollInterval  time.Duration
	processExists func(int) bool
	readFile      func(string) ([]byte, error)
	removeFile    func(string) error
	sleep         func(time.Duration)
	retryDelay    time.Duration
}

func newInstallCommandLock(command string) installCommandLock {
	return installCommandLock{
		command:       command,
		lockPath:      installCommandLockPath(command),
		now:           time.Now,
		pollInterval:  npmGlobalInstallLockPollInterval,
		processExists: tuttitypes.ProcessExists,
		readFile:      os.ReadFile,
		removeFile:    os.Remove,
		sleep:         time.Sleep,
		retryDelay:    npmGlobalInstallLockRecoverRetry,
	}
}

type InstallCommandLockRecoveryResult struct {
	LockPath string
	PID      int
	Removed  bool
	Reason   string
}

func (l installCommandLock) Acquire(ctx context.Context) (func(), error) {
	if !requiresInstallCommandLock(l.command) {
		return func() {}, nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	lockPath := strings.TrimSpace(l.lockPath)
	if lockPath == "" {
		return nil, errors.New("install command lock path is empty")
	}
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return nil, fmt.Errorf("create install lock directory: %w", err)
	}

	now := l.now
	if now == nil {
		now = time.Now
	}
	pollInterval := l.pollInterval
	if pollInterval <= 0 {
		pollInterval = npmGlobalInstallLockPollInterval
	}

	for {
		file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			if _, writeErr := fmt.Fprintf(
				file,
				"pid=%d\ncreated_at=%s\ncommand=%s\n",
				os.Getpid(),
				now().UTC().Format(time.RFC3339Nano),
				strings.TrimSpace(l.command),
			); writeErr != nil {
				_ = file.Close()
				_ = os.Remove(lockPath)
				return nil, fmt.Errorf("write install lock metadata: %w", writeErr)
			}
			if syncErr := file.Sync(); syncErr != nil {
				_ = file.Close()
				_ = os.Remove(lockPath)
				return nil, fmt.Errorf("sync install lock metadata: %w", syncErr)
			}
			released := false
			return func() {
				if released {
					return
				}
				released = true
				_ = file.Close()
				_ = os.Remove(lockPath)
			}, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("acquire install lock: %w", err)
		}

		timer := time.NewTimer(pollInterval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

// claudeCodeBinaryLockCommand serializes claude runtime binary provisioning
// (EnsureClaudeCodeBinary) across processes; it shares the download/staging
// paths under the state dir, so concurrent runs must not interleave.
const claudeCodeBinaryLockCommand = "claude-code-runtime-binary"

func requiresInstallCommandLock(command string) bool {
	command = strings.TrimSpace(command)
	return strings.HasPrefix(command, "npm install -g") ||
		strings.HasPrefix(command, "npm i -g") ||
		strings.HasPrefix(command, string(InstallerKindExternalAgentRegistryNPM)+":") ||
		command == claudeCodeBinaryLockCommand
}

func installCommandLockPath(command string) string {
	lockFile := "npm-global-install.lock"
	trimmed := strings.TrimSpace(command)
	switch {
	case strings.HasPrefix(trimmed, string(InstallerKindExternalAgentRegistryNPM)+":"):
		sum := sha256.Sum256([]byte(trimmed))
		lockFile = "agent-provider-install-" + hex.EncodeToString(sum[:8]) + ".lock"
	case trimmed == claudeCodeBinaryLockCommand:
		lockFile = "claude-code-runtime-binary.lock"
	}
	return filepath.Join(tuttitypes.TuttidRunDir(), "locks", lockFile)
}

func RecoverDefaultInstallCommandLock() (InstallCommandLockRecoveryResult, error) {
	lock := newInstallCommandLock("npm install -g")
	return lock.Recover()
}

func (l installCommandLock) Recover() (InstallCommandLockRecoveryResult, error) {
	lockPath := strings.TrimSpace(l.lockPath)
	result := InstallCommandLockRecoveryResult{LockPath: lockPath}
	if lockPath == "" {
		return result, errors.New("install command lock path is empty")
	}

	readFile := l.readFile
	if readFile == nil {
		readFile = os.ReadFile
	}
	body, err := readFile(lockPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return result, nil
		}
		return result, fmt.Errorf("read install lock: %w", err)
	}

	pid, err := parseInstallCommandLockPID(body)
	if err != nil {
		return l.removeMalformedLock(result)
	}
	result.PID = pid

	processExists := l.processExists
	if processExists == nil {
		processExists = tuttitypes.ProcessExists
	}
	if processExists(pid) {
		return result, nil
	}

	// Re-verify identity immediately before deletion: between the first read
	// and this point another process may have recovered the same orphan and
	// created its own live lock at this path. Only remove the file when it
	// still holds the exact bytes observed as stale, so a freshly created
	// lock is never deleted out from under its owner.
	current, err := readFile(lockPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return result, nil
		}
		return result, fmt.Errorf("re-read install lock before removal: %w", err)
	}
	if !bytes.Equal(current, body) {
		return result, nil
	}

	removeFile := l.removeFile
	if removeFile == nil {
		removeFile = os.Remove
	}
	if err := removeFile(lockPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return result, fmt.Errorf("remove install lock: %w", err)
	}
	result.Removed = true
	result.Reason = "dead_pid"
	return result, nil
}

func (l installCommandLock) removeMalformedLock(result InstallCommandLockRecoveryResult) (InstallCommandLockRecoveryResult, error) {
	sleep := l.sleep
	if sleep == nil {
		sleep = time.Sleep
	}
	retryDelay := l.retryDelay
	if retryDelay <= 0 {
		retryDelay = npmGlobalInstallLockRecoverRetry
	}
	sleep(retryDelay)

	readFile := l.readFile
	if readFile == nil {
		readFile = os.ReadFile
	}
	body, err := readFile(result.LockPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return result, nil
		}
		return result, fmt.Errorf("read install lock after retry: %w", err)
	}
	pid, err := parseInstallCommandLockPID(body)
	if err == nil {
		result.PID = pid
		processExists := l.processExists
		if processExists == nil {
			processExists = tuttitypes.ProcessExists
		}
		if processExists(pid) {
			return result, nil
		}
	}

	removeFile := l.removeFile
	if removeFile == nil {
		removeFile = os.Remove
	}
	if err := removeFile(result.LockPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return result, fmt.Errorf("remove malformed install lock: %w", err)
	}
	result.Removed = true
	result.Reason = "invalid_metadata"
	return result, nil
}

func parseInstallCommandLockPID(body []byte) (int, error) {
	lines := strings.Split(string(body), "\n")
	for _, line := range lines {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok || key != "pid" {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil || pid <= 0 {
			return 0, errors.New("install command lock pid is invalid")
		}
		return pid, nil
	}
	return 0, errors.New("install command lock pid is missing")
}
