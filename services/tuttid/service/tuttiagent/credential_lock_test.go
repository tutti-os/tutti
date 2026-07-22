package tuttiagent

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

const credentialLockChildAuthPathEnv = "TUTTI_CREDENTIAL_LOCK_CHILD_AUTH_PATH"
const credentialLockChildReadyPathEnv = "TUTTI_CREDENTIAL_LOCK_CHILD_READY_PATH"
const credentialLockChildHoldEnv = "TUTTI_CREDENTIAL_LOCK_CHILD_HOLD"

func TestTuttiAgentCredentialLockSerializesWriters(t *testing.T) {
	authPath := filepath.Join(t.TempDir(), ".tutti-agent", "auth.json")
	firstEntered := make(chan struct{})
	releaseFirst := make(chan struct{})
	firstDone := make(chan error, 1)
	go func() {
		firstDone <- withTuttiAgentCredentialLock(t.Context(), authPath, func() error {
			close(firstEntered)
			<-releaseFirst
			return nil
		})
	}()
	<-firstEntered

	secondEntered := make(chan struct{})
	secondDone := make(chan error, 1)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	go func() {
		secondDone <- withTuttiAgentCredentialLock(ctx, authPath, func() error {
			close(secondEntered)
			return nil
		})
	}()
	select {
	case <-secondEntered:
		t.Fatal("second writer entered before first released credential lock")
	case <-time.After(75 * time.Millisecond):
	}
	close(releaseFirst)
	if err := <-firstDone; err != nil {
		t.Fatalf("first writer error: %v", err)
	}
	select {
	case <-secondEntered:
	case <-ctx.Done():
		t.Fatalf("second writer did not acquire credential lock: %v", context.Cause(ctx))
	}
	if err := <-secondDone; err != nil {
		t.Fatalf("second writer error: %v", err)
	}
}

func TestTuttiAgentCredentialLockChildProcess(t *testing.T) {
	authPath := os.Getenv(credentialLockChildAuthPathEnv)
	if authPath == "" {
		return
	}
	readyPath := os.Getenv(credentialLockChildReadyPathEnv)
	if readyPath == "" {
		t.Fatal("child ready path is empty")
	}
	err := withTuttiAgentCredentialLock(t.Context(), authPath, func() error {
		if err := os.WriteFile(readyPath, []byte("locked"), 0o600); err != nil {
			return err
		}
		if hold, err := time.ParseDuration(os.Getenv(credentialLockChildHoldEnv)); err == nil && hold > 0 {
			time.Sleep(hold)
		}
		os.Exit(17)
		return nil
	})
	t.Fatalf("child lock unexpectedly returned: %v", err)
}

func TestTuttiAgentCredentialLockReleasedWhenProcessCrashes(t *testing.T) {
	root := t.TempDir()
	authPath := filepath.Join(root, ".tutti-agent", "auth.json")
	readyPath := filepath.Join(root, "child-ready")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(executable, "-test.run=^TestTuttiAgentCredentialLockChildProcess$")
	command.Env = append(os.Environ(),
		credentialLockChildAuthPathEnv+"="+authPath,
		credentialLockChildReadyPathEnv+"="+readyPath,
	)
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(readyPath); err == nil {
			break
		} else if !os.IsNotExist(err) {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatal("child did not acquire credential lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := command.Wait(); err == nil {
		t.Fatal("child should exit abruptly")
	}

	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if err := withTuttiAgentCredentialLock(ctx, authPath, func() error { return nil }); err != nil {
		t.Fatalf("parent could not acquire released credential lock: %v", err)
	}
}
