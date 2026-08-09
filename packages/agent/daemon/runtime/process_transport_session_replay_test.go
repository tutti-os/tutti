package agentruntime

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"
)

func TestSessionReplayProcessTransportRejectsInvalidRegistrations(t *testing.T) {
	for _, test := range []struct {
		name          string
		registrations []SessionReplayProcessRegistration
		want          string
	}{
		{
			name: "empty batch",
			want: "at least one registration",
		},
		{
			name: "missing identity",
			registrations: []SessionReplayProcessRegistration{{
				CassetteID:        "cassette-a",
				CassetteDirectory: "unused",
			}},
			want: "requires cassette, root Session, and Cassette directory",
		},
		{
			name: "duplicate cassette",
			registrations: []SessionReplayProcessRegistration{
				{CassetteID: "cassette-a", RootAgentSessionID: "root-a", CassetteDirectory: "unused-a"},
				{CassetteID: "cassette-a", RootAgentSessionID: "root-b", CassetteDirectory: "unused-b"},
			},
			want: `duplicate session replay cassette "cassette-a"`,
		},
		{
			name: "duplicate root",
			registrations: []SessionReplayProcessRegistration{
				{CassetteID: "cassette-a", RootAgentSessionID: "root-a", CassetteDirectory: "unused-a"},
				{CassetteID: "cassette-b", RootAgentSessionID: "root-a", CassetteDirectory: "unused-b"},
			},
			want: `duplicate session replay root Session "root-a"`,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := NewSessionReplayProcessTransport(test.registrations)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("NewSessionReplayProcessTransport() error = %v, want %q", err, test.want)
			}
		})
	}
}

func TestSessionReplayProcessTransportRoutesByRootAndFailsClosed(t *testing.T) {
	outboundA := []byte(`{"cassette":"a"}`)
	outboundB := []byte(`{"cassette":"b"}`)
	transport := newSessionReplayProcessTransportForTest(t,
		sessionReplayCassetteForTest(t, ProcessSpec{
			Provider:           ProviderCodex,
			AgentSessionID:     "child-a",
			RootAgentSessionID: "root-a",
		}, outboundA),
		sessionReplayCassetteForTest(t, ProcessSpec{
			Provider:       ProviderCodex,
			AgentSessionID: "root-b",
		}, outboundB),
	)

	connectionA, err := transport.Start(context.Background(), ProcessSpec{
		Provider:           ProviderCodex,
		AgentSessionID:     "child-a",
		RootAgentSessionID: "root-a",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := connectionA.Send(outboundA); err != nil {
		t.Fatal(err)
	}
	if err := transport.VerifyComplete("cassette-a"); err != nil {
		t.Fatal(err)
	}

	connectionB, err := transport.Start(context.Background(), ProcessSpec{
		Provider:       ProviderCodex,
		AgentSessionID: "root-b",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := connectionB.Send(outboundB); err != nil {
		t.Fatal(err)
	}
	if err := transport.VerifyComplete("cassette-b"); err != nil {
		t.Fatal(err)
	}

	_, err = transport.Start(context.Background(), ProcessSpec{
		Provider:       ProviderCodex,
		AgentSessionID: "unregistered-root",
	})
	if err == nil || !strings.Contains(err.Error(), "no registered root Session") {
		t.Fatalf("Start() error = %v, want fail-closed unregistered root", err)
	}
	_, err = transport.Start(context.Background(), ProcessSpec{
		Provider:       ProviderCodex,
		AgentSessionID: "child-a",
	})
	if err == nil || !strings.Contains(err.Error(), `"child-a"`) {
		t.Fatalf("Start() without root error = %v, want child identity rejection", err)
	}
}

func TestSessionReplayProcessTransportKeepsCassettePlaybackAndFailureIndependent(t *testing.T) {
	outboundA := []byte(`{"cassette":"a"}`)
	outboundB := []byte(`{"cassette":"b"}`)
	transport := newSessionReplayProcessTransportForTest(t,
		sessionReplayCassetteForTest(t, ProcessSpec{
			Provider:       ProviderCodex,
			AgentSessionID: "root-a",
		}, outboundA),
		sessionReplayCassetteForTest(t, ProcessSpec{
			Provider:       ProviderCodex,
			AgentSessionID: "root-b",
		}, outboundB),
	)

	if err := transport.PauseReplayPlayback("cassette-a"); err != nil {
		t.Fatal(err)
	}
	if err := transport.SetReplayPlaybackSpeed("cassette-b", 2); err != nil {
		t.Fatal(err)
	}
	stateA, err := transport.ReplayPlaybackState("cassette-a")
	if err != nil {
		t.Fatal(err)
	}
	stateB, err := transport.ReplayPlaybackState("cassette-b")
	if err != nil {
		t.Fatal(err)
	}
	if !stateA.Paused || stateA.Speed != 1 {
		t.Fatalf("cassette A playback = %#v, want paused at speed 1", stateA)
	}
	if stateB.Paused || stateB.Speed != 2 {
		t.Fatalf("cassette B playback = %#v, want running at speed 2", stateB)
	}
	if err := transport.ReplayFailure("cassette-a"); err != nil {
		t.Fatalf("unstarted cassette A failure = %v, want nil", err)
	}

	connectionA, err := transport.Start(context.Background(), ProcessSpec{
		Provider:       ProviderCodex,
		AgentSessionID: "root-a",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := transport.ReplayFailure("cassette-a"); err != nil {
		t.Fatalf("undrained cassette A failure = %v, want nil", err)
	}
	if err := connectionA.Send([]byte(`{"wrong":true}`)); err == nil {
		t.Fatal("cassette A outbound mismatch succeeded")
	}
	if err := transport.ReplayFailure("cassette-a"); err == nil {
		t.Fatal("cassette A failure is nil after mismatch")
	}
	if err := transport.ReplayFailure("cassette-b"); err != nil {
		t.Fatalf("cassette B failure after cassette A mismatch = %v, want nil", err)
	}

	connectionB, err := transport.Start(context.Background(), ProcessSpec{
		Provider:       ProviderCodex,
		AgentSessionID: "root-b",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := connectionB.Send(outboundB); err != nil {
		t.Fatalf("cassette B send after cassette A failure: %v", err)
	}
	if err := transport.VerifyComplete("cassette-b"); err != nil {
		t.Fatalf("cassette B verification after cassette A failure: %v", err)
	}
	if err := transport.VerifyComplete("cassette-a"); err == nil {
		t.Fatal("cassette A verification succeeded after mismatch")
	}
	if _, err := transport.ReplayPlaybackState("missing"); err == nil {
		t.Fatal("unknown replay cassette playback lookup succeeded")
	}
	if err := transport.ReplayFailure("missing"); err == nil {
		t.Fatal("unknown replay cassette failure lookup succeeded")
	}
}

type sessionReplayCassetteFixture struct {
	cassetteID string
	rootID     string
	directory  string
}

func newSessionReplayProcessTransportForTest(
	t *testing.T,
	fixtures ...sessionReplayCassetteFixture,
) *SessionReplayProcessTransport {
	t.Helper()
	registrations := make([]SessionReplayProcessRegistration, 0, len(fixtures))
	for _, fixture := range fixtures {
		registrations = append(registrations, SessionReplayProcessRegistration{
			CassetteID:         fixture.cassetteID,
			RootAgentSessionID: fixture.rootID,
			CassetteDirectory:  fixture.directory,
		})
	}
	transport, err := NewSessionReplayProcessTransport(registrations)
	if err != nil {
		t.Fatal(err)
	}
	return transport
}

func sessionReplayCassetteForTest(
	t *testing.T,
	spec ProcessSpec,
	outbound []byte,
) sessionReplayCassetteFixture {
	t.Helper()
	directory := t.TempDir()
	writer, err := newProcessCassetteWriter(directory)
	if err != nil {
		t.Fatal(err)
	}
	connectionID, err := writer.start(spec, ProcessCassetteCaptureOriginProcessStart)
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.append(processCassetteChunk{
		ConnectionID: connectionID,
		ChunkSeq:     1,
		Kind:         "outbound",
		Data:         base64.StdEncoding.EncodeToString(outbound),
	}); err != nil {
		t.Fatal(err)
	}
	if err := writer.finishConnection(); err != nil {
		t.Fatal(err)
	}
	if err := writer.finalize(); err != nil {
		t.Fatal(err)
	}
	rootID := rootProcessSessionID(spec)
	return sessionReplayCassetteFixture{
		cassetteID: "cassette-" + strings.TrimPrefix(rootID, "root-"),
		rootID:     rootID,
		directory:  directory,
	}
}
