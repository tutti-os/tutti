package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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

func TestValidateConnectorProcessSpecMarksContractViolationInvalid(t *testing.T) {
	err := validateConnectorProcessSpec(ProcessSpec{
		Command:            []string{"/usr/bin/node"},
		ExecutableIdentity: &ExecutableIdentity{SHA256: "abc", SizeBytes: 1},
		Env: []string{
			"HTTP_PROXY=http://127.0.0.1:7897",
			"http_proxy=http://127.0.0.1:7897",
		},
	})
	if !errors.Is(err, ErrProcessSpecInvalid) {
		t.Fatalf("err = %v, want ErrProcessSpecInvalid", err)
	}
}

func TestNewConnectorProcessTransportUsesConnectorValidation(t *testing.T) {
	transport, err := NewConnectorProcessTransport()
	if err != nil || transport == nil {
		t.Fatalf("NewConnectorProcessTransport() = %#v, %v", transport, err)
	}
	connection, err := transport.Start(context.Background(), ProcessSpec{})
	if connection != nil || err == nil || !strings.Contains(err.Error(), "command is required") {
		t.Fatalf("Start() = %#v, %v", connection, err)
	}
}

func TestConnectorProcessTransportRequiresAbsoluteVerifiedExecutable(t *testing.T) {
	transport := newConnectorProcessTransport(1024, 1024)
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
	transport := newConnectorProcessTransport(1024, 1024)
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
	transport := newConnectorProcessTransport(4096, 4096)
	connection, err := transport.Start(context.Background(), ProcessSpec{
		Command:            []string{path, "-test.run=TestConnectorProcessFixture"},
		ExecutableIdentity: identity,
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
	transport := newConnectorProcessTransport(32, 4096)
	connection, err := transport.Start(context.Background(), ProcessSpec{
		Command:            []string{path, "-test.run=TestConnectorProcessFixture"},
		ExecutableIdentity: identity,
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
	transport := newConnectorProcessTransport(4096, 4096)
	_, err = transport.Start(context.Background(), ProcessSpec{Command: []string{path}, ExecutableIdentity: identity,
		ArtifactTrees: []ArtifactTreeIdentity{{Root: artifactRoot, SHA256: inventory}}})
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
