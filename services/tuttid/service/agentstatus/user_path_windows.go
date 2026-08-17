//go:build windows

package agentstatus

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	userEnvironmentKey = `Environment`
	userPathValue      = `Path`
	wmSettingChange    = 0x001A
	hwndBroadcast      = 0xffff
	smtoAbortIfHung    = 0x0002
)

type userEnvironmentStore interface {
	ReadPath() (string, uint32, error)
	WritePath(string, uint32) error
}

type windowsUserPathAdapter struct {
	store     userEnvironmentStore
	broadcast func() error
}

// The registry update is a read/modify/write operation. Serialize it across
// all Tutti daemons in this process so concurrent Codex and Tutti Agent
// installs cannot lose one another's PATH entry.
var windowsUserPathMu sync.Mutex

func newUserPathAdapter() UserPathAdapter {
	return windowsUserPathAdapter{
		store:     windowsUserEnvironmentStore{},
		broadcast: broadcastEnvironmentChange,
	}
}

func (a windowsUserPathAdapter) Ensure(ctx context.Context, directory string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	directory = strings.TrimSpace(directory)
	if directory == "" {
		return errors.New("user PATH directory is empty")
	}
	if !filepath.IsAbs(directory) {
		return fmt.Errorf("user PATH directory must be absolute: %q", directory)
	}
	windowsUserPathMu.Lock()
	defer windowsUserPathMu.Unlock()
	current, valueType, err := a.store.ReadPath()
	if err != nil {
		return fmt.Errorf("read HKCU\\Environment\\Path: %w", err)
	}
	updated, changed := appendWindowsPathEntry(current, directory)
	if !changed {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := a.store.WritePath(updated, valueType); err != nil {
		return fmt.Errorf("write HKCU\\Environment\\Path: %w", err)
	}
	if a.broadcast == nil {
		return nil
	}
	if err := a.broadcast(); err != nil {
		return fmt.Errorf("broadcast environment change: %w", err)
	}
	return nil
}

func appendWindowsPathEntry(pathValue, directory string) (string, bool) {
	directory = filepath.Clean(strings.TrimSpace(directory))
	for _, entry := range strings.Split(pathValue, ";") {
		if windowsPathEntryEqual(entry, directory) {
			return pathValue, false
		}
	}
	if strings.TrimSpace(pathValue) == "" {
		return directory, true
	}
	return pathValue + ";" + directory, true
}

func windowsPathEntryEqual(left, right string) bool {
	left = strings.Trim(strings.TrimSpace(left), `"`)
	right = strings.Trim(strings.TrimSpace(right), `"`)
	if left == "" || right == "" {
		return false
	}
	if expanded, err := registry.ExpandString(left); err == nil {
		left = expanded
	}
	if expanded, err := registry.ExpandString(right); err == nil {
		right = expanded
	}
	return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
}

type windowsUserEnvironmentStore struct{}

func (windowsUserEnvironmentStore) ReadPath() (string, uint32, error) {
	key, err := registry.OpenKey(registry.CURRENT_USER, userEnvironmentKey, registry.QUERY_VALUE)
	if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
		return "", registry.SZ, nil
	}
	if err != nil {
		return "", 0, err
	}
	defer key.Close()
	value, valueType, err := key.GetStringValue(userPathValue)
	if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
		return "", registry.SZ, nil
	}
	if err != nil {
		return "", 0, err
	}
	if valueType != registry.SZ && valueType != registry.EXPAND_SZ {
		return "", 0, fmt.Errorf("HKCU\\Environment\\Path has unsupported registry type %d", valueType)
	}
	return value, valueType, nil
}

func (windowsUserEnvironmentStore) WritePath(value string, valueType uint32) error {
	key, _, err := registry.CreateKey(
		registry.CURRENT_USER,
		userEnvironmentKey,
		registry.CREATE_SUB_KEY|registry.SET_VALUE|registry.QUERY_VALUE,
	)
	if err != nil {
		return err
	}
	defer key.Close()
	switch valueType {
	case registry.EXPAND_SZ:
		return key.SetExpandStringValue(userPathValue, value)
	case registry.SZ, 0:
		return key.SetStringValue(userPathValue, value)
	default:
		return fmt.Errorf("unsupported registry string type %d", valueType)
	}
}

func broadcastEnvironmentChange() error {
	user32 := windows.NewLazySystemDLL("user32.dll")
	sendMessageTimeout := user32.NewProc("SendMessageTimeoutW")
	environment, err := windows.UTF16PtrFromString("Environment")
	if err != nil {
		return err
	}
	var result uintptr
	returnErr := error(nil)
	r1, _, callErr := sendMessageTimeout.Call(
		uintptr(hwndBroadcast),
		uintptr(wmSettingChange),
		0,
		uintptr(unsafe.Pointer(environment)),
		uintptr(smtoAbortIfHung),
		5000,
		uintptr(unsafe.Pointer(&result)),
	)
	if r1 == 0 {
		returnErr = callErr
		if returnErr == nil || returnErr == windows.ERROR_SUCCESS {
			returnErr = errors.New("SendMessageTimeoutW returned zero")
		}
	}
	return returnErr
}
