package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type testConnectorSandbox struct{}

func (testConnectorSandbox) Apply(*exec.Cmd, ProcessSpec) error { return nil }

func TestConnectorProcessFixture(_ *testing.T) {
	if os.Getenv("TUTTI_CONNECTOR_PROCESS_FIXTURE") != "1" {
		return
	}
	if count := os.Getenv("TUTTI_CONNECTOR_OUTPUT_BYTES"); count != "" {
		fmt.Print(strings.Repeat("x", 1024))
		return
	}
	fmt.Printf("allowed=%s leaked=%s", os.Getenv("ALLOWED_VALUE"), os.Getenv("SECRET_SHOULD_NOT_LEAK"))
	if fd := os.Getenv("TUTTI_CONNECTOR_FD_CREDENTIAL"); fd != "" {
		var descriptor int
		_, _ = fmt.Sscanf(fd, "%d", &descriptor)
		secret, _ := io.ReadAll(os.NewFile(uintptr(descriptor), "credential"))
		fmt.Printf(" credential=%s", secret)
	}
}

func TestNewConnectorProcessTransportDefersUnsupportedSandboxFailureToLaunch(t *testing.T) {
	transport, err := NewConnectorProcessTransport()
	if err != nil || transport == nil {
		t.Fatalf("NewConnectorProcessTransport() = %#v, %v", transport, err)
	}
	if runtime.GOOS == "darwin" {
		return
	}
	connection, err := transport.Start(context.Background(), ProcessSpec{})
	if connection != nil || !errors.Is(err, ErrConnectorProcessSandboxUnsupported) {
		t.Fatalf("Start() = %#v, %v", connection, err)
	}
}

func TestConnectorProcessTransportRequiresAbsoluteVerifiedExecutable(t *testing.T) {
	transport := newConnectorProcessTransport(testConnectorSandbox{}, 1024, 1024)
	if _, err := transport.Start(context.Background(), ProcessSpec{Command: []string{"node"}}); err == nil || !strings.Contains(err.Error(), "absolute") {
		t.Fatalf("relative command error = %v", err)
	}
	path, _ := copyCurrentExecutableWithIdentity(t)
	if _, err := transport.Start(context.Background(), ProcessSpec{Command: []string{path}}); err == nil || !strings.Contains(err.Error(), "identity") {
		t.Fatalf("missing identity error = %v", err)
	}
}

func TestConnectorProcessTransportRejectsReservedOrMalformedEnvironmentKeys(t *testing.T) {
	path, identity := copyCurrentExecutableWithIdentity(t)
	transport := newConnectorProcessTransport(testConnectorSandbox{}, 1024, 1024)
	for _, environment := range [][]string{
		{"TUTTI_CONNECTOR_FD_CREDENTIAL=3"},
		{" BAD=value"},
		{"BAD-NAME=value"},
		{"9BAD=value"},
		{"PATH=/trusted", "path=/untrusted"},
	} {
		if _, err := transport.Start(context.Background(), ProcessSpec{
			Command: []string{path}, ExecutableIdentity: identity, Env: environment,
		}); err == nil {
			t.Fatalf("Start(Env=%#v) error = nil, want rejection", environment)
		}
	}
}

func TestConnectorProcessTransportUsesExplicitEnvironmentAndSensitiveFD(t *testing.T) {
	t.Setenv("SECRET_SHOULD_NOT_LEAK", "daemon-secret")
	path, identity := copyCurrentExecutableWithIdentity(t)
	credential, err := os.CreateTemp(t.TempDir(), "credential")
	if err != nil {
		t.Fatal(err)
	}
	defer credential.Close()
	if _, err := credential.WriteString("fd-secret"); err != nil {
		t.Fatal(err)
	}
	if _, err := credential.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	transport := newConnectorProcessTransport(testConnectorSandbox{}, 4096, 4096)
	connection, err := transport.Start(context.Background(), ProcessSpec{
		Command:            []string{path, "-test.run=TestConnectorProcessFixture"},
		ExecutableIdentity: identity,
		ConnectorSandbox:   &ConnectorSandboxPolicy{},
		Env: []string{
			"TUTTI_CONNECTOR_PROCESS_FIXTURE=1",
			"ALLOWED_VALUE=visible",
		},
		SensitiveInheritedFiles: []SensitiveInheritedFile{{
			File: credential, DescriptorEnvKey: "TUTTI_CONNECTOR_FD_CREDENTIAL", Purpose: "test credential",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	var stdout strings.Builder
	for {
		frame, err := connection.Recv()
		if err != nil {
			t.Fatal(err)
		}
		stdout.Write(frame.Stdout)
		if frame.ExitCode != nil {
			break
		}
	}
	if got := stdout.String(); !strings.HasPrefix(got, "allowed=visible leaked= credential=fd-secret") || strings.Contains(got, "daemon-secret") {
		t.Fatalf("stdout = %q", got)
	}
}

func TestConnectorProcessTransportEnforcesOutputLimit(t *testing.T) {
	path, identity := copyCurrentExecutableWithIdentity(t)
	transport := newConnectorProcessTransport(testConnectorSandbox{}, 32, 4096)
	connection, err := transport.Start(context.Background(), ProcessSpec{
		Command:            []string{path, "-test.run=TestConnectorProcessFixture"},
		ExecutableIdentity: identity,
		ConnectorSandbox:   &ConnectorSandboxPolicy{},
		Env: []string{
			"TUTTI_CONNECTOR_PROCESS_FIXTURE=1",
			"TUTTI_CONNECTOR_OUTPUT_BYTES=1024",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	for {
		_, err := connection.Recv()
		if err == nil {
			continue
		}
		if !strings.Contains(err.Error(), "stdout exceeds limit") {
			t.Fatalf("Recv() error = %v", err)
		}
		break
	}
}

func TestConnectorProcessTransportRejectsPreparedTreeMutationAtLaunch(t *testing.T) {
	path, identity := copyCurrentExecutableWithIdentity(t)
	artifactRoot := t.TempDir()
	entrypoint := filepath.Join(artifactRoot, "connector.js")
	if err := os.WriteFile(entrypoint, []byte("trusted"), 0o600); err != nil {
		t.Fatal(err)
	}
	inventory, err := connectorTreeInventoryDigest(artifactRoot)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entrypoint, []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
	transport := newConnectorProcessTransport(testConnectorSandbox{}, 4096, 4096)
	_, err = transport.Start(context.Background(), ProcessSpec{Command: []string{path}, ExecutableIdentity: identity,
		ConnectorSandbox: &ConnectorSandboxPolicy{ReadOnlyPaths: []string{artifactRoot},
			ReadOnlyTreeIdentities: []ReadOnlyTreeIdentity{{Root: artifactRoot, SHA256: inventory}}}})
	if err == nil || !strings.Contains(err.Error(), "changed before launch") {
		t.Fatalf("Start() error = %v, want prepared-tree identity rejection", err)
	}
}

func TestLocalProcessTransportRejectsSensitiveInheritedFiles(t *testing.T) {
	_, err := NewLocalProcessTransport().Start(context.Background(), ProcessSpec{
		Command: []string{"ignored"},
		SensitiveInheritedFiles: []SensitiveInheritedFile{{
			File: os.Stdin, DescriptorEnvKey: "TUTTI_CONNECTOR_FD_SECRET", Purpose: "secret",
		}},
	})
	if err == nil || !strings.Contains(err.Error(), "connector process transport") {
		t.Fatalf("Start() error = %v", err)
	}
}
