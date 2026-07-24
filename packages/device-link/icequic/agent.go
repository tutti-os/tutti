package icequic

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"sync"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/logging"
	"github.com/pion/stun/v3"

	"github.com/tutti-os/tutti/packages/device-link/internal/netfilter"
)

// Network scope classifications for a negotiated ICE pair. Values match the
// core devicelink PathScope / devicelinkdiag NetworkScope strings so callers
// can cast directly; classification is categorical and carries no address.
const (
	ScopeLocalSubnet    = "local_subnet"
	ScopePrivateNetwork = "private_network"
	ScopePublicInternet = "public_internet"
	maxSTUNEndpoints    = 8
	maxSTUNEndpointSize = 128
)

// redactingLoggerFactory disables pion's logging entirely. Pion's default
// logger writes to stderr (honoring PION_LOG_*) and some candidate/warning
// paths include raw candidate and srflx public addresses, which would violate
// the device-link "raw addresses never in logs" invariant. Discarding all pion
// output enforces that regardless of environment.
type redactingLoggerFactory struct{}

func (redactingLoggerFactory) NewLogger(string) logging.LeveledLogger { return discardLogger{} }

type discardLogger struct{}

func (discardLogger) Trace(string)          {}
func (discardLogger) Tracef(string, ...any) {}
func (discardLogger) Debug(string)          {}
func (discardLogger) Debugf(string, ...any) {}
func (discardLogger) Info(string)           {}
func (discardLogger) Infof(string, ...any)  {}
func (discardLogger) Warn(string)           {}
func (discardLogger) Warnf(string, ...any)  {}
func (discardLogger) Error(string)          {}
func (discardLogger) Errorf(string, ...any) {}

// AgentConfig configures a device-link ICE agent under the proposal's razor
// (shared-agent-p2p-nat-traversal.md, D1/D2): UDP only, host + server-reflexive
// candidate types, mDNS disabled, TURN disabled. STUNEndpoints are the
// server-provided IP-literal STUN URLs; an empty list means host-only
// gathering, which is also the graceful degradation when STUN is unavailable.
type AgentConfig struct {
	STUNEndpoints []string
	// NetworkPolicySystem follows OS routing, including TUN interfaces.
	// NetworkPolicyDirect pins UDP sockets to eligible physical interfaces and
	// is supported on macOS only. Empty defaults to system.
	NetworkPolicy NetworkPolicy
	// STUNGatherTimeout bounds how long gathering waits for STUN responses
	// before completing host-only. Zero uses pion's default (5s). Bounding it
	// implements the proposal's "STUN unavailable degrades to host-only" without
	// stalling the rendezvous.
	STUNGatherTimeout time.Duration
	// IncludeLoopback gathers loopback host candidates. It defaults to false
	// (production) and is enabled only by tests / interface-less CI, matching
	// the M2 slice; it never affects the deployed razor.
	IncludeLoopback bool
	// ExcludeHostCandidates drops directly-bound host candidates from ICE
	// gathering, leaving only server-reflexive (srflx) — the v3 half of the
	// "disable LAN candidates" switch, so ICE still hole punches off
	// the STUN endpoint while reliance shifts away from the LAN.
	ExcludeHostCandidates bool
}

// LocalParams is one participant's ICE pairing material for the rendezvous
// attempt payload: credentials plus the gathered candidates marshalled as
// pion's own SDP candidate fragments. Candidate strings are sensitive (they may
// embed a public srflx address) and must not enter ordinary logs or metrics.
type LocalParams struct {
	Ufrag      string
	Pwd        string
	Candidates []string
}

// Agent wraps a pion ICE agent restricted to the device-link razor and exposes
// the two operations the rendezvous flow needs: publish local pairing material,
// then connect to the peer's material over the negotiated path. It is the only
// place device-link code depends on pion/ice directly.
type Agent struct {
	agent *ice.Agent

	mu               sync.Mutex
	candidates       []string
	remoteCandidates map[string]struct{}
	changed          chan struct{}
	gathered         chan struct{}
	done             chan struct{}
	gatherOnce       sync.Once
	closeOnce        sync.Once
	startOnce        sync.Once
	startErr         error
}

// NewAgent builds an ICE agent under the device-link razor. TURN and mDNS are
// off by construction (no TURN URLs, MulticastDNSModeDisabled); only host and
// server-reflexive candidates over UDP are gathered.
func NewAgent(cfg AgentConfig) (*Agent, error) {
	networkPolicy, err := normalizeNetworkPolicy(cfg.NetworkPolicy)
	if err != nil {
		return nil, err
	}
	agentOptions := []ice.AgentOption{
		ice.WithNetworkTypes([]ice.NetworkType{
			ice.NetworkTypeUDP4,
			ice.NetworkTypeUDP6,
		}),
		ice.WithCandidateTypes(ICECandidateTypes(cfg.ExcludeHostCandidates)),
		ice.WithMulticastDNSMode(ice.MulticastDNSModeDisabled),
		ice.WithLoggerFactory(redactingLoggerFactory{}),
	}
	if cfg.STUNGatherTimeout > 0 {
		agentOptions = append(agentOptions, ice.WithSTUNGatherTimeout(cfg.STUNGatherTimeout))
	}
	if cfg.IncludeLoopback {
		agentOptions = append(agentOptions, ice.WithIncludeLoopback())
	}
	if len(cfg.STUNEndpoints) > maxSTUNEndpoints {
		return nil, fmt.Errorf("device-link STUN endpoint list exceeds %d entries", maxSTUNEndpoints)
	}
	seenEndpoints := make(map[string]struct{}, len(cfg.STUNEndpoints))
	stunURLs := make([]*stun.URI, 0, len(cfg.STUNEndpoints))
	for _, rawEndpoint := range cfg.STUNEndpoints {
		if len(rawEndpoint) > maxSTUNEndpointSize {
			return nil, fmt.Errorf("device-link STUN endpoint exceeds %d bytes", maxSTUNEndpointSize)
		}
		endpoint := strings.TrimSpace(rawEndpoint)
		if endpoint == "" {
			return nil, errors.New("device-link STUN endpoint must not be empty")
		}
		uri, err := stun.ParseURI(endpoint)
		if err != nil {
			return nil, fmt.Errorf("parse device-link STUN endpoint: %w", err)
		}
		if uri.Scheme != stun.SchemeTypeSTUN && uri.Scheme != stun.SchemeTypeSTUNS {
			return nil, errors.New("device-link STUN endpoint must use the stun scheme")
		}
		address, err := netip.ParseAddr(uri.Host)
		if err != nil {
			return nil, errors.New("device-link STUN endpoint must use an IP literal")
		}
		testLoopback := cfg.IncludeLoopback && address.Unmap().IsLoopback()
		if !testLoopback && !netfilter.PublicInternetIPAllowed(address) {
			return nil, errors.New("device-link STUN endpoint must use a public Internet address")
		}
		canonical := uri.String()
		if _, ok := seenEndpoints[canonical]; ok {
			continue
		}
		seenEndpoints[canonical] = struct{}{}
		stunURLs = append(stunURLs, uri)
	}
	if len(stunURLs) > 0 {
		agentOptions = append(agentOptions, ice.WithUrls(stunURLs))
	}
	if networkPolicy == NetworkPolicyDirect {
		netTransport, err := newInterfaceBoundNet(cfg.IncludeLoopback)
		if err != nil {
			return nil, err
		}
		agentOptions = append(
			agentOptions,
			ice.WithNet(netTransport),
			ice.WithInterfaceFilter(func(name string) bool {
				return netfilter.InterfaceNameAllowed(name, cfg.IncludeLoopback)
			}),
			ice.WithIPFilter(func(ip net.IP) bool {
				return netfilter.IPAllowed(ip, cfg.IncludeLoopback)
			}),
		)
	}
	underlying, err := ice.NewAgentWithOptions(agentOptions...)
	if err != nil {
		return nil, fmt.Errorf("new device-link ICE agent: %w", err)
	}
	a := &Agent{
		agent: underlying, gathered: make(chan struct{}), changed: make(chan struct{}, 1), done: make(chan struct{}),
		remoteCandidates: make(map[string]struct{}),
	}
	if err := underlying.OnCandidate(a.onCandidate); err != nil {
		_ = underlying.Close()
		return nil, fmt.Errorf("register device-link ICE candidate handler: %w", err)
	}
	return a, nil
}

// onCandidate accumulates gathered candidates as SDP fragments. A nil candidate
// signals gathering completion.
func (a *Agent) onCandidate(candidate ice.Candidate) {
	if candidate == nil {
		a.gatherOnce.Do(func() { close(a.gathered) })
		return
	}
	// Re-marshal through the exact wire round-trip the peer will perform, so a
	// candidate that cannot survive serialization is never advertised.
	marshalled := candidate.Marshal()
	if _, err := ice.UnmarshalCandidate(marshalled); err != nil {
		return
	}
	a.mu.Lock()
	a.candidates = append(a.candidates, marshalled)
	a.mu.Unlock()
	select {
	case a.changed <- struct{}{}:
	default:
	}
}

// StartGathering starts pion's asynchronous gather and immediately returns ICE
// credentials plus the candidates already delivered by pion (normally host
// candidates). It never waits for STUN gathering to finish.
func (a *Agent) StartGathering() (LocalParams, error) {
	if a == nil || a.agent == nil {
		return LocalParams{}, errors.New("device-link ICE agent is not initialized")
	}
	a.startOnce.Do(func() {
		a.startErr = a.agent.GatherCandidates()
	})
	if a.startErr != nil {
		return LocalParams{}, fmt.Errorf("gather device-link ICE candidates: %w", a.startErr)
	}
	return a.LocalParamsSnapshot()
}

// LocalParamsSnapshot returns credentials and the candidates gathered so far.
func (a *Agent) LocalParamsSnapshot() (LocalParams, error) {
	if a == nil || a.agent == nil {
		return LocalParams{}, errors.New("device-link ICE agent is not initialized")
	}
	ufrag, pwd, err := a.agent.GetLocalUserCredentials()
	if err != nil {
		return LocalParams{}, fmt.Errorf("device-link ICE credentials: %w", err)
	}
	a.mu.Lock()
	candidates := append([]string(nil), a.candidates...)
	a.mu.Unlock()
	return LocalParams{Ufrag: ufrag, Pwd: pwd, Candidates: candidates}, nil
}

// CandidateChanges coalesces local-candidate arrival notifications. Candidate
// values are intentionally available only through LocalParamsSnapshot so they
// cannot accidentally be attached to logs or diagnostics.
func (a *Agent) CandidateChanges() <-chan struct{} { return a.changed }

// GatheringComplete is closed when pion reports end-of-candidates.
func (a *Agent) GatheringComplete() <-chan struct{} { return a.gathered }

// Done is closed when the wrapper is explicitly closed.
func (a *Agent) Done() <-chan struct{} { return a.done }

// LocalParams gathers candidates (blocking until gathering completes or ctx is
// done) and returns the local pairing material. STUN failures do not error:
// gathering completes with whatever candidates (host, and srflx if reachable)
// were collected, matching the proposal's "STUN unavailable degrades to
// host-only" behavior.
func (a *Agent) LocalParams(ctx context.Context) (LocalParams, error) {
	if a == nil || a.agent == nil {
		return LocalParams{}, errors.New("device-link ICE agent is not initialized")
	}
	if _, err := a.StartGathering(); err != nil {
		return LocalParams{}, err
	}
	select {
	case <-a.gathered:
	case <-ctx.Done():
		return LocalParams{}, ctx.Err()
	}
	params, err := a.LocalParamsSnapshot()
	if err != nil {
		return LocalParams{}, err
	}
	candidates := params.Candidates
	if len(candidates) == 0 {
		return LocalParams{}, errors.New("device-link ICE agent gathered no candidates")
	}
	return params, nil
}

// AddRemoteCandidates trickles newly reflected peer candidates into pion. Raw
// candidate strings are deduplicated before parsing; repeats and malformed
// entries are harmless and never logged.
func (a *Agent) AddRemoteCandidates(remoteCandidates []string) int {
	if a == nil || a.agent == nil {
		return 0
	}
	added := 0
	for _, raw := range remoteCandidates {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		a.mu.Lock()
		if _, exists := a.remoteCandidates[raw]; exists {
			a.mu.Unlock()
			continue
		}
		a.remoteCandidates[raw] = struct{}{}
		a.mu.Unlock()
		candidate, err := ice.UnmarshalCandidate(raw)
		if err != nil {
			continue
		}
		if err := a.agent.AddRemoteCandidate(candidate); err == nil {
			added++
		}
	}
	return added
}

// Connect adds the peer's remote candidates and negotiates a path. controlling
// must be true on exactly one side (the caller/Dial side) and false on the
// other (the owner/Accept side). The returned packet conn is the ICE-selected
// path ready for NewQUICEndpointFromPacketConn.
func (a *Agent) Connect(ctx context.Context, remoteUfrag, remotePwd string, remoteCandidates []string, controlling bool) (*SinglePeerPacketConn, error) {
	if a == nil || a.agent == nil {
		return nil, errors.New("device-link ICE agent is not initialized")
	}
	remoteUfrag = strings.TrimSpace(remoteUfrag)
	remotePwd = strings.TrimSpace(remotePwd)
	if remoteUfrag == "" || remotePwd == "" {
		return nil, errors.New("device-link ICE connect requires peer credentials")
	}
	a.AddRemoteCandidates(remoteCandidates)
	var (
		conn *ice.Conn
		err  error
	)
	if controlling {
		conn, err = a.agent.Dial(ctx, remoteUfrag, remotePwd)
	} else {
		conn, err = a.agent.Accept(ctx, remoteUfrag, remotePwd)
	}
	if err != nil {
		return nil, fmt.Errorf("device-link ICE path negotiation: %w", err)
	}
	packetConn, err := NewSinglePeerPacketConn(conn)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	return packetConn, nil
}

// SelectedScope classifies the negotiated candidate pair into a categorical
// network scope (never an address). A server-reflexive endpoint on either side
// means the path crossed a NAT (public_internet); a global-unicast host address
// is likewise public; private/ULA host pairs are private_network. It must be
// called after Connect. An unknown pair yields ScopePrivateNetwork, the safe
// conservative default. The finer local_subnet refinement needs interface-prefix
// data the ICE agent does not expose, so private_network is used for private
// host pairs.
func (a *Agent) SelectedScope() string {
	if a == nil || a.agent == nil {
		return ScopePrivateNetwork
	}
	pair, err := a.agent.GetSelectedCandidatePair()
	if err != nil || pair == nil || pair.Local == nil || pair.Remote == nil {
		return ScopePrivateNetwork
	}
	if pair.Local.Type() == ice.CandidateTypeServerReflexive || pair.Remote.Type() == ice.CandidateTypeServerReflexive {
		return ScopePublicInternet
	}
	if ip, err := netip.ParseAddr(pair.Remote.Address()); err == nil {
		if ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLoopback() {
			return ScopePrivateNetwork
		}
		if ip.IsGlobalUnicast() {
			return ScopePublicInternet
		}
	}
	return ScopePrivateNetwork
}

// Close releases the ICE agent and its sockets after establishment fails or the
// QUIC session over the selected path has been closed.
func (a *Agent) Close() error {
	if a == nil || a.agent == nil {
		return nil
	}
	a.closeOnce.Do(func() { close(a.done) })
	return a.agent.Close()
}
