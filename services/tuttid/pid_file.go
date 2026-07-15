package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

var errPIDFileLocked = errors.New("pid file is locked")

type pidFileLease struct {
	lockFile *os.File
	pidPath  string
	body     []byte
}

func acquirePIDFile() (*pidFileLease, error) {
	pidPath := tuttitypes.TuttidPIDPath()
	if err := os.MkdirAll(filepath.Dir(pidPath), 0o755); err != nil {
		return nil, fmt.Errorf("create pid file directory: %w", err)
	}

	lockPath := pidPath + ".lock"
	file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open state ownership lock: %w", err)
	}
	if err := lockPIDFile(file); err != nil {
		_ = file.Close()
		if errors.Is(err, errPIDFileLocked) {
			return nil, existingDaemonError(pidPath)
		}
		return nil, fmt.Errorf("lock state ownership file: %w", err)
	}

	existingBody, err := os.ReadFile(pidPath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		unlockAndClosePIDFile(file)
		return nil, fmt.Errorf("read pid file: %w", err)
	}
	if existingPID, ok := parsePID(existingBody); ok && tuttitypes.ProcessExists(existingPID) {
		unlockAndClosePIDFile(file)
		return nil, fmt.Errorf("state directory is already owned by live tuttid process %d", existingPID)
	}

	body := []byte(fmt.Sprintf("%d\n", os.Getpid()))
	if err := os.WriteFile(pidPath, body, 0o644); err != nil {
		unlockAndClosePIDFile(file)
		return nil, fmt.Errorf("write pid file: %w", err)
	}

	return &pidFileLease{lockFile: file, pidPath: pidPath, body: body}, nil
}

func existingDaemonError(pidPath string) error {
	body, err := os.ReadFile(pidPath)
	if err == nil {
		if pid, ok := parsePID(body); ok && tuttitypes.ProcessExists(pid) {
			return fmt.Errorf("state directory is already owned by live tuttid process %d", pid)
		}
	}
	return errors.New("state directory is already owned by another tuttid process")
}

func parsePID(body []byte) (int, bool) {
	pid, err := strconv.Atoi(strings.TrimSpace(string(body)))
	return pid, err == nil && pid > 1
}

func unlockAndClosePIDFile(file *os.File) {
	_ = unlockPIDFile(file)
	_ = file.Close()
}

func (l *pidFileLease) Release() {
	if l == nil || l.lockFile == nil {
		return
	}
	currentBody, err := os.ReadFile(l.pidPath)
	if err == nil && string(currentBody) == string(l.body) {
		_ = os.Remove(l.pidPath)
	}
	unlockAndClosePIDFile(l.lockFile)
	l.lockFile = nil
}
