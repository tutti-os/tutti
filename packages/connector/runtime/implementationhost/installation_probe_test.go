package implementationhost

import (
	"context"
	"errors"
	"io"
	"testing"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
)

type installationProbeConnection struct {
	frames []agentruntime.ProcessFrame
	index  int
}

func (*installationProbeConnection) Send([]byte) error { return nil }
func (*installationProbeConnection) Close() error      { return nil }
func (connection *installationProbeConnection) Recv() (agentruntime.ProcessFrame, error) {
	if connection.index >= len(connection.frames) {
		return agentruntime.ProcessFrame{}, io.EOF
	}
	frame := connection.frames[connection.index]
	connection.index++
	return frame, nil
}

func TestWaitInstallationProbeUsesOnlyDeclaredExitCodes(t *testing.T) {
	for _, test := range []struct {
		name    string
		exit    int
		present bool
		wantErr bool
	}{
		{name: "present", exit: 0, present: true},
		{name: "absent", exit: 1},
		{name: "indeterminate", exit: 2, wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			connection := &installationProbeConnection{frames: []agentruntime.ProcessFrame{{Stdout: []byte("probe\n")}, {ExitCode: &test.exit}}}
			present, err := waitInstallationProbe(context.Background(), connection)
			if present != test.present || (err != nil) != test.wantErr {
				t.Fatalf("present=%v error=%v", present, err)
			}
		})
	}
}

func TestWaitInstallationProbeRejectsMissingExitAndOversizedOutput(t *testing.T) {
	if _, err := waitInstallationProbe(context.Background(), &installationProbeConnection{}); err == nil {
		t.Fatal("EOF without exit code was accepted")
	}
	connection := &installationProbeConnection{frames: []agentruntime.ProcessFrame{{Stdout: make([]byte, maxInstallationProbeOutput+1)}}}
	if _, err := waitInstallationProbe(context.Background(), connection); err == nil || errors.Is(err, io.EOF) {
		t.Fatalf("oversized output error = %v", err)
	}
}
