package icequic

import (
	"context"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/pion/logging"

	corelink "github.com/tutti-os/tutti/packages/device-link"
)

// TestAgentWireFormCarriesDeviceLinkQUIC exercises the M4 v3 lane end to end
// through the exact rendezvous wire form: each side publishes LocalParams
// (ufrag/pwd + marshalled SDP candidate strings), the strings cross as they
// would in the attempt payload, and the device-link QUIC transport with pinned
// certificates runs over the ICE-selected path.
func TestAgentWireFormCarriesDeviceLinkQUIC(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	caller, err := NewAgent(AgentConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatalf("new caller agent: %v", err)
	}
	defer caller.Close()
	owner, err := NewAgent(AgentConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatalf("new owner agent: %v", err)
	}
	defer owner.Close()

	callerParams, err := caller.LocalParams(ctx)
	if err != nil {
		t.Fatalf("caller local params: %v", err)
	}
	ownerParams, err := owner.LocalParams(ctx)
	if err != nil {
		t.Fatalf("owner local params: %v", err)
	}
	if callerParams.Ufrag == "" || callerParams.Pwd == "" || len(callerParams.Candidates) == 0 {
		t.Fatalf("caller params incomplete: %+v", callerParams)
	}

	type connResult struct {
		conn *SinglePeerPacketConn
		err  error
	}
	ownerConnCh := make(chan connResult, 1)
	go func() {
		conn, connErr := owner.Connect(ctx, callerParams.Ufrag, callerParams.Pwd, callerParams.Candidates, false)
		ownerConnCh <- connResult{conn: conn, err: connErr}
	}()
	callerConn, err := caller.Connect(ctx, ownerParams.Ufrag, ownerParams.Pwd, ownerParams.Candidates, true)
	if err != nil {
		t.Fatalf("caller connect: %v", err)
	}
	ownerRes := <-ownerConnCh
	if ownerRes.err != nil {
		t.Fatalf("owner connect: %v", ownerRes.err)
	}

	// IncludeLoopback adds loopback candidates; it does not force pion to select
	// them over eligible physical interfaces. Both peers must nevertheless agree
	// on a valid categorical scope for the selected pair.
	callerScope, ownerScope := caller.SelectedScope(), owner.SelectedScope()
	if callerScope != ownerScope {
		t.Fatalf("selected scopes differ: caller=%q owner=%q", callerScope, ownerScope)
	}
	if callerScope != ScopePrivateNetwork && callerScope != ScopePublicInternet {
		t.Fatalf("caller SelectedScope = %q, want a valid selected-pair scope", callerScope)
	}

	callerIdentity, err := corelink.NewEphemeralIdentity(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	ownerIdentity, err := corelink.NewEphemeralIdentity(time.Now())
	if err != nil {
		t.Fatal(err)
	}

	ownerEndpoint, err := corelink.NewQUICEndpointFromPacketConn(ownerRes.conn)
	if err != nil {
		t.Fatal(err)
	}
	defer ownerEndpoint.Close()
	ownerTLS, err := ownerIdentity.ServerTLSConfig(callerIdentity.Fingerprint)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := ownerEndpoint.Listen(ownerTLS)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	type sessResult struct {
		session *corelink.QUICSession
		err     error
	}
	ownerSessCh := make(chan sessResult, 1)
	go func() {
		session, acceptErr := listener.Accept(ctx)
		ownerSessCh <- sessResult{session: session, err: acceptErr}
	}()

	callerEndpoint, err := corelink.NewQUICEndpointFromPacketConn(callerConn)
	if err != nil {
		t.Fatal(err)
	}
	defer callerEndpoint.Close()
	callerTLS, err := callerIdentity.ClientTLSConfig(ownerIdentity.Fingerprint)
	if err != nil {
		t.Fatal(err)
	}
	callerSession, err := callerEndpoint.Dial(ctx, callerConn.RemoteAddr(), callerTLS)
	if err != nil {
		t.Fatalf("QUIC dial over ICE path: %v", err)
	}
	defer callerSession.Close()
	ownerSess := <-ownerSessCh
	if ownerSess.err != nil {
		t.Fatalf("QUIC accept over ICE path: %v", ownerSess.err)
	}
	defer ownerSess.session.Close()

	echoDone := make(chan error, 1)
	go func() {
		stream, streamErr := ownerSess.session.AcceptStream(ctx)
		if streamErr != nil {
			echoDone <- streamErr
			return
		}
		defer stream.Close()
		_, copyErr := io.Copy(stream, stream)
		echoDone <- copyErr
	}()

	stream, err := callerSession.OpenStream(ctx)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	payload := []byte("m4-v3-ice-lane-wire-form")
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
			t.Fatalf("owner echo: %v", err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestNewAgentRejectsNonSTUNEndpoint(t *testing.T) {
	if _, err := NewAgent(AgentConfig{STUNEndpoints: []string{"turn:relay.example.com:3478"}}); err == nil {
		t.Fatal("expected non-stun scheme to be rejected")
	}
	agent, err := NewAgent(AgentConfig{STUNEndpoints: []string{"stun:8.8.8.8:3478"}})
	if err != nil {
		t.Fatalf("valid stun endpoint rejected: %v", err)
	}
	defer agent.Close()
	ipv6Agent, err := NewAgent(AgentConfig{STUNEndpoints: []string{"stun:[2606:4700:4700::1111]:3478"}})
	if err != nil {
		t.Fatalf("valid IPv6 stun endpoint rejected: %v", err)
	}
	defer ipv6Agent.Close()
}

func TestNewAgentRejectsSchemelessSTUNEndpoint(t *testing.T) {
	if _, err := NewAgent(AgentConfig{STUNEndpoints: []string{"stun.example.com:3478"}}); err == nil {
		t.Fatal("scheme-less STUN endpoint must be rejected")
	}
}

func TestNewAgentRejectsHostnameSTUNEndpointWithoutLocalDNS(t *testing.T) {
	for _, policy := range []NetworkPolicy{NetworkPolicySystem, NetworkPolicyDirect} {
		if _, err := NewAgent(AgentConfig{
			NetworkPolicy: policy,
			STUNEndpoints: []string{"stun:stun.example.com:3478"},
		}); err == nil || !strings.Contains(err.Error(), "IP literal") {
			t.Fatalf("NewAgent(%q hostname) error = %v, want IP-literal rejection", policy, err)
		}
	}
}

func TestNewAgentRejectsUnsafeOrOversizedSTUNEndpoints(t *testing.T) {
	for _, endpoint := range []string{
		"",
		"stun:127.0.0.1:3478",
		"stun:10.0.0.1:3478",
		"stun:[100::1]:3478",
		"stun:[2001:2::1]:3478",
	} {
		if _, err := NewAgent(AgentConfig{STUNEndpoints: []string{endpoint}}); err == nil {
			t.Fatalf("NewAgent(%q) succeeded, want rejection", endpoint)
		}
	}

	tooMany := make([]string, maxSTUNEndpoints+1)
	for i := range tooMany {
		tooMany[i] = "stun:8.8.8.8:3478"
	}
	if _, err := NewAgent(AgentConfig{STUNEndpoints: tooMany}); err == nil {
		t.Fatal("oversized STUN endpoint list must be rejected")
	}
	if _, err := NewAgent(AgentConfig{STUNEndpoints: []string{"stun:" + strings.Repeat("1", maxSTUNEndpointSize) + ":3478"}}); err == nil {
		t.Fatal("oversized STUN endpoint must be rejected")
	}
}

func TestNewAgentAllowsLoopbackSTUNOnlyForTests(t *testing.T) {
	agent, err := NewAgent(AgentConfig{STUNEndpoints: []string{"stun:127.0.0.1:3478"}, IncludeLoopback: true})
	if err != nil {
		t.Fatalf("test loopback STUN endpoint rejected: %v", err)
	}
	defer agent.Close()
}

func TestNewAgentRejectsUnknownNetworkPolicy(t *testing.T) {
	if _, err := NewAgent(AgentConfig{NetworkPolicy: "unknown"}); err == nil {
		t.Fatal("unknown network policy must be rejected")
	}
}

func TestAgentExcludeHostCandidatesThreadsToGathering(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Baseline: loopback is a host candidate, so it is gathered when host is
	// allowed — proving the fixture would otherwise produce candidates.
	withHost, err := NewAgent(AgentConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer withHost.Close()
	base, err := withHost.LocalParams(ctx)
	if err != nil {
		t.Fatalf("baseline local params: %v", err)
	}
	if len(base.Candidates) == 0 {
		t.Fatal("baseline should gather the loopback host candidate")
	}

	// With host excluded and no STUN source, gathering yields nothing, so
	// LocalParams reports "gathered no candidates" — this proves
	// AgentConfig.ExcludeHostCandidates reaches the pion candidate types (the
	// shared LAN kill switch); the same fixture produced a
	// candidate above only because host was allowed.
	noHost, err := NewAgent(AgentConfig{IncludeLoopback: true, ExcludeHostCandidates: true, STUNGatherTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer noHost.Close()
	if _, err := noHost.LocalParams(ctx); err == nil {
		t.Fatal("host-excluded gathering with no STUN should yield no candidates and error")
	}
}

// TestAgentSuppressesPionLogging enforces the privacy invariant: even with
// pion trace logging requested via PION_LOG_*, the injected redacting factory
// must discard everything, so no candidate/srflx address can reach stderr.
func TestAgentSuppressesPionLogging(t *testing.T) {
	// Direct assertion: the factory yields the discard logger.
	if _, ok := (redactingLoggerFactory{}).NewLogger("test").(discardLogger); !ok {
		t.Fatal("redacting factory must produce the discard logger")
	}
	var _ logging.LoggerFactory = redactingLoggerFactory{}

	t.Setenv("PION_LOG_TRACE", "all")
	t.Setenv("PION_LOG_DEBUG", "all")
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	orig := os.Stderr
	os.Stderr = w
	restored := false
	restore := func() {
		if !restored {
			os.Stderr = orig
			restored = true
		}
	}
	defer restore()

	agent, err := NewAgent(AgentConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, _ = agent.LocalParams(ctx)
	_ = agent.Close()

	_ = w.Close()
	restore()
	out, _ := io.ReadAll(r)
	if len(out) != 0 {
		t.Fatalf("pion emitted %d bytes to stderr despite redacting factory: %q", len(out), out)
	}
}

func TestConnectRejectsMissingCredentials(t *testing.T) {
	agent, err := NewAgent(AgentConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer agent.Close()
	if _, err := agent.Connect(context.Background(), "", "pwd", []string{"x"}, true); err == nil {
		t.Fatal("expected missing ufrag to be rejected")
	}
}

func TestConnectAcceptsLateDuplicateOutOfOrderCandidates(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	caller, err := NewAgent(AgentConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer caller.Close()
	owner, err := NewAgent(AgentConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	callerParams, err := caller.LocalParams(ctx)
	if err != nil {
		t.Fatal(err)
	}
	ownerParams, err := owner.LocalParams(ctx)
	if err != nil {
		t.Fatal(err)
	}

	type result struct {
		conn *SinglePeerPacketConn
		err  error
	}
	ownerResult := make(chan result, 1)
	callerResult := make(chan result, 1)
	go func() {
		conn, connectErr := owner.Connect(ctx, callerParams.Ufrag, callerParams.Pwd, nil, false)
		ownerResult <- result{conn, connectErr}
	}()
	go func() {
		conn, connectErr := caller.Connect(ctx, ownerParams.Ufrag, ownerParams.Pwd, nil, true)
		callerResult <- result{conn, connectErr}
	}()
	time.Sleep(50 * time.Millisecond)
	for i := len(callerParams.Candidates) - 1; i >= 0; i-- {
		owner.AddRemoteCandidates([]string{callerParams.Candidates[i], callerParams.Candidates[i]})
	}
	for i := len(ownerParams.Candidates) - 1; i >= 0; i-- {
		caller.AddRemoteCandidates([]string{ownerParams.Candidates[i], ownerParams.Candidates[i]})
	}
	callerRes, ownerRes := <-callerResult, <-ownerResult
	if callerRes.err != nil {
		t.Fatalf("caller connect after trickle: %v", callerRes.err)
	}
	if ownerRes.err != nil {
		t.Fatalf("owner connect after trickle: %v", ownerRes.err)
	}
	defer callerRes.conn.Close()
	defer ownerRes.conn.Close()
	if got := caller.AddRemoteCandidates(ownerParams.Candidates); got != 0 {
		t.Fatalf("duplicate candidate feed added %d candidates, want 0", got)
	}
}
