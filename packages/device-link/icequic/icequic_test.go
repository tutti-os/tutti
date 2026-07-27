package icequic

import (
	"context"
	"io"
	"testing"
	"time"

	"github.com/pion/ice/v4"

	corelink "github.com/tutti-os/tutti/packages/device-link"
)

// TestICESelectedPathCarriesDeviceLinkQUIC is the M2 vertical slice from the
// NAT-traversal proposal: two ICE agents negotiate a path (candidate
// exchange, connectivity checks, nomination — the same machinery that hole
// punches through NATs), and the device-link QUIC transport with pinned
// ephemeral certificates runs over the selected connection unchanged.
func TestICESelectedPathCarriesDeviceLinkQUIC(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	controlling := newTestAgent(t)
	controlled := newTestAgent(t)
	wireCandidates(t, controlling, controlled)
	wireCandidates(t, controlled, controlling)
	if err := controlling.GatherCandidates(); err != nil {
		t.Fatalf("gather controlling candidates: %v", err)
	}
	if err := controlled.GatherCandidates(); err != nil {
		t.Fatalf("gather controlled candidates: %v", err)
	}

	controllingUfrag, controllingPwd, err := controlling.GetLocalUserCredentials()
	if err != nil {
		t.Fatalf("controlling credentials: %v", err)
	}
	controlledUfrag, controlledPwd, err := controlled.GetLocalUserCredentials()
	if err != nil {
		t.Fatalf("controlled credentials: %v", err)
	}

	type iceResult struct {
		conn *ice.Conn
		err  error
	}
	accepted := make(chan iceResult, 1)
	go func() {
		conn, acceptErr := controlled.Accept(ctx, controllingUfrag, controllingPwd)
		accepted <- iceResult{conn: conn, err: acceptErr}
	}()
	dialConn, err := controlling.Dial(ctx, controlledUfrag, controlledPwd)
	if err != nil {
		t.Fatalf("ICE dial: %v", err)
	}
	acceptResult := <-accepted
	if acceptResult.err != nil {
		t.Fatalf("ICE accept: %v", acceptResult.err)
	}

	clientPC, err := NewSinglePeerPacketConn(dialConn)
	if err != nil {
		t.Fatal(err)
	}
	serverPC, err := NewSinglePeerPacketConn(acceptResult.conn)
	if err != nil {
		t.Fatal(err)
	}

	clientIdentity, err := corelink.NewEphemeralIdentity(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	serverIdentity, err := corelink.NewEphemeralIdentity(time.Now())
	if err != nil {
		t.Fatal(err)
	}

	serverEndpoint, err := corelink.NewQUICEndpointFromPacketConn(serverPC)
	if err != nil {
		t.Fatal(err)
	}
	defer serverEndpoint.Close()
	serverTLS, err := serverIdentity.ServerTLSConfig(clientIdentity.Fingerprint)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := serverEndpoint.Listen(serverTLS)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	type quicResult struct {
		session *corelink.QUICSession
		err     error
	}
	serverSessions := make(chan quicResult, 1)
	go func() {
		session, acceptErr := listener.Accept(ctx)
		serverSessions <- quicResult{session: session, err: acceptErr}
	}()

	clientEndpoint, err := corelink.NewQUICEndpointFromPacketConn(clientPC)
	if err != nil {
		t.Fatal(err)
	}
	defer clientEndpoint.Close()
	clientTLS, err := clientIdentity.ClientTLSConfig(serverIdentity.Fingerprint)
	if err != nil {
		t.Fatal(err)
	}
	clientSession, err := clientEndpoint.Dial(ctx, clientPC.RemoteAddr(), clientTLS)
	if err != nil {
		t.Fatalf("QUIC dial over ICE path: %v", err)
	}
	defer clientSession.Close()
	serverResult := <-serverSessions
	if serverResult.err != nil {
		t.Fatalf("QUIC accept over ICE path: %v", serverResult.err)
	}
	defer serverResult.session.Close()

	echoDone := make(chan error, 1)
	go func() {
		stream, streamErr := serverResult.session.AcceptStream(ctx)
		if streamErr != nil {
			echoDone <- streamErr
			return
		}
		defer stream.Close()
		_, copyErr := io.Copy(stream, stream)
		echoDone <- copyErr
	}()

	stream, err := clientSession.OpenStream(ctx)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	payload := []byte("quic-over-ice-vertical-slice")
	if _, err := stream.Write(payload); err != nil {
		t.Fatalf("write payload: %v", err)
	}
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(stream, got); err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if string(got) != string(payload) {
		t.Fatalf("echo = %q, want %q", got, payload)
	}
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-echoDone:
		if err != nil && err != io.EOF {
			t.Fatalf("server echo: %v", err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

// newTestAgent builds a UDP host-candidate agent. Loopback is included so the
// slice runs on interface-less CI machines; real deployments gather physical
// interfaces plus STUN srflx candidates instead.
func newTestAgent(t *testing.T) *ice.Agent {
	t.Helper()
	agent, err := ice.NewAgentWithOptions(
		ice.WithNetworkTypes([]ice.NetworkType{ice.NetworkTypeUDP4}),
		ice.WithCandidateTypes(ICECandidateTypes(false)),
		ice.WithIncludeLoopback(),
	)
	if err != nil {
		t.Fatalf("new ICE agent: %v", err)
	}
	t.Cleanup(func() { _ = agent.Close() })
	return agent
}

// wireCandidates forwards from's gathered candidates into to, marshalling
// through the wire form exactly as the rendezvous attempt payload will.
func wireCandidates(t *testing.T, from, to *ice.Agent) {
	t.Helper()
	if err := from.OnCandidate(func(candidate ice.Candidate) {
		if candidate == nil {
			return
		}
		parsed, err := ice.UnmarshalCandidate(candidate.Marshal())
		if err != nil {
			t.Errorf("unmarshal candidate: %v", err)
			return
		}
		if err := to.AddRemoteCandidate(parsed); err != nil {
			t.Errorf("add remote candidate: %v", err)
		}
	}); err != nil {
		t.Fatalf("wire candidates: %v", err)
	}
}
