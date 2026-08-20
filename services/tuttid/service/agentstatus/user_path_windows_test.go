//go:build windows

package agentstatus

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"golang.org/x/sys/windows/registry"
)

type fakeUserEnvironmentStore struct {
	value     string
	valueType uint32
	readErr   error
	writeErr  error
	writes    int
	lastValue string
	lastType  uint32
}

func (s *fakeUserEnvironmentStore) ReadPath() (string, uint32, error) {
	return s.value, s.valueType, s.readErr
}

func (s *fakeUserEnvironmentStore) WritePath(value string, valueType uint32) error {
	s.writes++
	s.lastValue = value
	s.lastType = valueType
	if s.writeErr != nil {
		return s.writeErr
	}
	s.value = value
	s.valueType = valueType
	return nil
}

func TestAppendWindowsPathEntryIsIdempotentAndCaseInsensitive(t *testing.T) {
	pathValue := `C:\Windows\System32;C:\Users\Tester\.Local\Bin\`
	updated, changed := appendWindowsPathEntry(pathValue, `C:\Users\Tester\.local\bin`)
	if changed || updated != pathValue {
		t.Fatalf("appendWindowsPathEntry() = %q, %t; want unchanged value", updated, changed)
	}
}

func TestAppendWindowsPathEntryExpandsExistingEnvironmentVariables(t *testing.T) {
	root := t.TempDir()
	t.Setenv("TUTTI_TEST_BIN", root)
	want := filepath.Join(root, "bin")
	updated, changed := appendWindowsPathEntry(`%TUTTI_TEST_BIN%\bin`, want)
	if changed || updated != `%TUTTI_TEST_BIN%\bin` {
		t.Fatalf("appendWindowsPathEntry() = %q, %t; want unchanged expanded entry", updated, changed)
	}
}

func TestWindowsUserPathAdapterPreservesExistingPathAndRegistryType(t *testing.T) {
	store := &fakeUserEnvironmentStore{
		value:     `C:\Windows\System32;C:\Tools\bin`,
		valueType: registry.EXPAND_SZ,
	}
	broadcasts := 0
	adapter := windowsUserPathAdapter{
		store: store,
		broadcast: func() error {
			broadcasts++
			return nil
		},
	}
	if err := adapter.Ensure(context.Background(), `C:\Users\Tester\.local\bin`); err != nil {
		t.Fatalf("Ensure() error = %v", err)
	}
	if store.writes != 1 || store.lastType != registry.EXPAND_SZ {
		t.Fatalf("writes = %d, type = %d; want one EXPAND_SZ write", store.writes, store.lastType)
	}
	want := `C:\Windows\System32;C:\Tools\bin;C:\Users\Tester\.local\bin`
	if store.lastValue != want {
		t.Fatalf("written PATH = %q, want %q", store.lastValue, want)
	}
	if broadcasts != 1 {
		t.Fatalf("broadcasts = %d, want 1", broadcasts)
	}
}

func TestWindowsUserPathAdapterDoesNotWriteWhenEntryAlreadyExists(t *testing.T) {
	store := &fakeUserEnvironmentStore{value: `C:\Users\Tester\.local\bin`, valueType: registry.SZ}
	broadcasts := 0
	adapter := windowsUserPathAdapter{
		store: store,
		broadcast: func() error {
			broadcasts++
			return nil
		},
	}
	if err := adapter.Ensure(context.Background(), `C:\Users\Tester\.LOCAL\BIN\`); err != nil {
		t.Fatalf("Ensure() error = %v", err)
	}
	if store.writes != 0 || broadcasts != 0 {
		t.Fatalf("writes = %d, broadcasts = %d; want no-op", store.writes, broadcasts)
	}
}

func TestWindowsUserPathAdapterPropagatesWriteFailure(t *testing.T) {
	wantErr := errors.New("denied")
	store := &fakeUserEnvironmentStore{writeErr: wantErr, valueType: registry.SZ}
	adapter := windowsUserPathAdapter{store: store}
	if err := adapter.Ensure(context.Background(), `C:\Users\Tester\.local\bin`); err == nil || !errors.Is(err, wantErr) {
		t.Fatalf("Ensure() error = %v, want wrapped write error", err)
	}
}

func TestWindowsUserPathAdapterSerializesConcurrentUpdates(t *testing.T) {
	store := &fakeUserEnvironmentStore{valueType: registry.SZ}
	adapter := windowsUserPathAdapter{store: store}
	directories := []string{
		`C:\Users\Tester\.local\bin`,
		`C:\Users\Tester\.local\tutti-agent\bin`,
	}
	var wait sync.WaitGroup
	for _, directory := range directories {
		wait.Add(1)
		go func(directory string) {
			defer wait.Done()
			if err := adapter.Ensure(context.Background(), directory); err != nil {
				t.Errorf("Ensure(%q) error = %v", directory, err)
			}
		}(directory)
	}
	wait.Wait()
	for _, directory := range directories {
		if !strings.Contains(strings.ToLower(store.value), strings.ToLower(directory)) {
			t.Fatalf("serialized PATH update lost %q: %q", directory, store.value)
		}
	}
	if store.writes != len(directories) {
		t.Fatalf("writes = %d, want %d", store.writes, len(directories))
	}
}
