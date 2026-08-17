package mobile

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	devicelink "github.com/tutti-os/tutti/packages/device-link"
	authenticated "github.com/tutti-os/tutti/packages/device-link/authenticated"
	"github.com/tutti-os/tutti/packages/device-link/candidateexchange"
	"github.com/tutti-os/tutti/packages/device-link/linkmanager"
	"github.com/tutti-os/tutti/packages/device-link/relaytransport"
)

const (
	ApplicationProtocolEpoch = 1
	defaultLinkTimeout       = 30 * time.Second
	maxMobileStreamRead      = 1 << 20
	transportDirect          = "direct"
	transportRelay           = "relay"
)

type Link struct {
	participant *authenticated.Participant

	mu            sync.Mutex
	candidatePump *candidateexchange.ActionPump
	connected     *authenticated.Link
	connectDone   chan struct{}
	connectOnce   sync.Once
	connectErr    error
	closed        bool
}

type candidateExchangeAction struct {
	ActionID    uint64                       `json:"actionId"`
	Kind        candidateexchange.ActionKind `json:"kind"`
	Description *authenticated.Description   `json:"description,omitempty"`
}

func ProtocolEpoch() int { return ApplicationProtocolEpoch }

func NewLink(stunEndpointsJSON string) (*Link, error) {
	var stunEndpoints []string
	if stunEndpointsJSON != "" {
		if err := json.Unmarshal([]byte(stunEndpointsJSON), &stunEndpoints); err != nil {
			return nil, fmt.Errorf("decode device-link STUN endpoints: %w", err)
		}
	}
	participant, err := authenticated.NewParticipant(authenticated.ParticipantConfig{
		STUNEndpoints:     stunEndpoints,
		STUNGatherTimeout: 5 * time.Second,
	})
	if err != nil {
		return nil, err
	}
	return newLink(participant), nil
}

func NewLoopbackLink() (*Link, error) {
	participant, err := authenticated.NewParticipant(authenticated.ParticipantConfig{
		IncludeLoopback: true,
	})
	if err != nil {
		return nil, err
	}
	return newLink(participant), nil
}

func newLink(participant *authenticated.Participant) *Link {
	return &Link{
		participant: participant,
		connectDone: make(chan struct{}),
	}
}

// DialRelay opens one product-configured Relay byte stream. The mobile
// binding keeps the Relay endpoint, query, headers, and subprotocol opaque;
// account, pairing, and target authorization remain owned by the caller.
// queryJSON and headersJSON encode map[string][]string values so the API stays
// safe for gomobile bindings.
func DialRelay(
	endpoint string,
	queryJSON string,
	headersJSON string,
	subprotocol string,
	timeoutMillis int64,
) (*Stream, error) {
	query, err := decodeRelayValues(queryJSON, "query")
	if err != nil {
		return nil, err
	}
	headers, err := decodeRelayValues(headersJSON, "headers")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), linkTimeout(timeoutMillis))
	defer cancel()
	conn, err := relaytransport.Dial(ctx, relaytransport.DialRequest{
		Endpoint:    endpoint,
		Query:       query,
		Header:      http.Header(headers),
		Subprotocol: subprotocol,
	})
	if err != nil {
		return nil, err
	}
	if err := devicelink.ProbeStream(ctx, conn); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("probe Relay stream: %w", err)
	}
	return &Stream{conn: conn, transport: transportRelay}, nil
}

func (l *Link) LocalDescription(timeoutMillis int64) (string, error) {
	if l == nil || l.participant == nil {
		return "", errors.New("device-link mobile participant is unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), linkTimeout(timeoutMillis))
	defer cancel()
	description, err := l.participant.LocalDescription(ctx)
	if err != nil {
		return "", err
	}
	return encodeLocalDescription(description)
}

// StartLocalDescription starts candidate gathering without waiting for STUN
// completion. The returned description always contains credentials and may
// contain zero candidates; callers must drain NextCandidateExchangeAction
// while Connect is in progress.
func (l *Link) StartLocalDescription() (string, error) {
	if l == nil || l.participant == nil {
		return "", errors.New("device-link mobile participant is unavailable")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return "", errors.New("device-link mobile session is closed")
	}
	if l.candidatePump != nil {
		return "", errors.New("device-link local description already started")
	}
	exchange, initial, err := candidateexchange.Start(l.participant, candidateexchange.Config{})
	if err != nil {
		return "", err
	}
	pump, err := candidateexchange.NewActionPump(exchange)
	if err != nil {
		return "", err
	}
	l.candidatePump = pump
	return encodeLocalDescription(initial)
}

// NextCandidateExchangeAction returns one Go-scheduled product rendezvous
// action. Mobile executes only the signed I/O and resolves the action; worker
// ordering, retry delay, polling, and cancellation remain Go-owned.
func (l *Link) NextCandidateExchangeAction(timeoutMillis int64) (string, error) {
	pump, err := l.candidateActionPump()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), linkTimeout(timeoutMillis))
	defer cancel()
	action, err := pump.Next(ctx)
	if err != nil {
		return "", err
	}
	envelope := candidateExchangeAction{ActionID: action.ID, Kind: action.Kind}
	if action.Kind == candidateexchange.ActionPublishLocal {
		description := action.Description
		description.Candidates = append([]string{}, description.Candidates...)
		envelope.Description = &description
	}
	raw, err := json.Marshal(envelope)
	if err != nil {
		return "", fmt.Errorf("encode device-link candidate exchange action: %w", err)
	}
	return string(raw), nil
}

// ResolveCandidateExchangeAction reports product rendezvous I/O completion.
// candidatesJSON is consumed only by a successful refresh_remote action.
func (l *Link) ResolveCandidateExchangeAction(
	actionID int64,
	succeeded bool,
	retryable bool,
	candidatesJSON string,
) (int, error) {
	pump, err := l.candidateActionPump()
	if err != nil {
		return 0, err
	}
	if actionID <= 0 {
		return 0, errors.New("device-link candidate action identity is invalid")
	}
	var candidates []string
	if succeeded && strings.TrimSpace(candidatesJSON) != "" {
		if err := json.Unmarshal([]byte(candidatesJSON), &candidates); err != nil {
			return 0, fmt.Errorf("decode device-link remote candidates: %w", err)
		}
	}
	if candidates == nil {
		candidates = []string{}
	}
	added, err := pump.Resolve(uint64(actionID), candidateexchange.ActionOutcome{
		Succeeded: succeeded, Retryable: retryable, RemoteCandidates: candidates,
	})
	if err != nil {
		return 0, fmt.Errorf("resolve device-link candidate exchange action: %w", err)
	}
	return added, nil
}

// NotifyRemoteCandidateChange forwards a product push hint into the shared
// push-plus-poll scheduler. Notifications coalesce until the next fetch.
func (l *Link) NotifyRemoteCandidateChange() error {
	pump, err := l.candidateActionPump()
	if err != nil {
		return err
	}
	pump.NotifyRemoteChange()
	return nil
}

// StopCandidateExchange cancels local publication and remote refresh waits
// without closing an already authenticated link.
func (l *Link) StopCandidateExchange() {
	if l == nil {
		return
	}
	l.mu.Lock()
	pump := l.candidatePump
	l.candidatePump = nil
	l.mu.Unlock()
	if pump != nil {
		pump.Stop()
	}
}

func (l *Link) Connect(peerDescriptionJSON string, caller bool, timeoutMillis int64) (string, error) {
	if l == nil || l.participant == nil {
		return "", errors.New("device-link mobile participant is unavailable")
	}
	var peer authenticated.Description
	if err := json.Unmarshal([]byte(peerDescriptionJSON), &peer); err != nil {
		connectErr := fmt.Errorf("decode device-link peer description: %w", err)
		l.recordConnectError(connectErr)
		return "", connectErr
	}
	role := authenticated.RoleOwner
	if caller {
		role = authenticated.RoleCaller
	}
	ctx, cancel := context.WithTimeout(context.Background(), linkTimeout(timeoutMillis))
	defer cancel()
	connected, err := l.participant.Connect(ctx, peer, role)
	if err != nil {
		l.recordConnectError(err)
		return "", err
	}
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		_ = connected.Close()
		l.signalConnectDone()
		return "", errors.New("device-link mobile participant closed while connecting")
	}
	l.connected = connected
	l.mu.Unlock()
	l.signalConnectDone()
	return connected.SelectedScope(), nil
}

func (l *Link) OpenStream(timeoutMillis int64) (*Stream, error) {
	ctx, cancel := context.WithTimeout(context.Background(), linkTimeout(timeoutMillis))
	defer cancel()
	stream, err := l.openStreamContext(ctx)
	if err != nil {
		return nil, err
	}
	return &Stream{conn: stream, transport: transportDirect}, nil
}

// OpenStreamWithRelay starts the direct and Relay stream dials together. Each
// candidate must complete the shared DeviceLink stream probe before it can win;
// a QUIC stream that only allocated locally is not considered usable. The
// losing dial is canceled by the shared race context. A Link may still be
// completing Connect, so the direct dial waits for that operation while Relay
// starts immediately.
func (l *Link) OpenStreamWithRelay(
	endpoint string,
	queryJSON string,
	headersJSON string,
	subprotocol string,
	timeoutMillis int64,
) (*Stream, error) {
	query, err := decodeRelayValues(queryJSON, "query")
	if err != nil {
		return nil, err
	}
	headers, err := decodeRelayValues(headersJSON, "headers")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), linkTimeout(timeoutMillis))
	defer cancel()
	result, err := linkmanager.Race(ctx, linkmanager.RaceConfig{
		Primary: linkmanager.DialPath{
			Name: transportDirect,
			Dial: func(dialCtx context.Context) (net.Conn, error) {
				return l.openStreamContext(dialCtx)
			},
		},
		Fallback: linkmanager.DialPath{
			Name: transportRelay,
			Dial: func(dialCtx context.Context) (net.Conn, error) {
				conn, dialErr := relaytransport.Dial(dialCtx, relaytransport.DialRequest{
					Endpoint:    endpoint,
					Query:       query,
					Header:      http.Header(headers),
					Subprotocol: subprotocol,
				})
				if dialErr != nil {
					return nil, dialErr
				}
				if probeErr := devicelink.ProbeStream(dialCtx, conn); probeErr != nil {
					_ = conn.Close()
					return nil, fmt.Errorf("probe Relay stream: %w", probeErr)
				}
				return conn, nil
			},
		},
		FallbackDelay: 0,
	})
	if err != nil {
		return nil, err
	}
	return &Stream{conn: result.Conn, transport: result.Path}, nil
}

func (l *Link) AcceptStream(timeoutMillis int64) (*Stream, error) {
	ctx, cancel := context.WithTimeout(context.Background(), linkTimeout(timeoutMillis))
	defer cancel()
	connected, err := l.waitConnected(ctx)
	if err != nil {
		return nil, err
	}
	stream, err := connected.AcceptStream(ctx)
	if err != nil {
		return nil, err
	}
	return &Stream{conn: stream, transport: transportDirect}, nil
}

func (l *Link) Close() error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return nil
	}
	l.closed = true
	connected := l.connected
	participant := l.participant
	candidatePump := l.candidatePump
	l.candidatePump = nil
	l.mu.Unlock()
	if candidatePump != nil {
		candidatePump.Stop()
	}
	l.signalConnectDone()
	if connected != nil {
		return connected.Close()
	}
	if participant != nil {
		return participant.Close()
	}
	return nil
}

func (l *Link) signalConnectDone() {
	if l == nil {
		return
	}
	l.connectOnce.Do(func() {
		if l.connectDone != nil {
			close(l.connectDone)
		}
	})
}

func (l *Link) recordConnectError(err error) {
	l.mu.Lock()
	l.connectErr = err
	l.mu.Unlock()
	l.signalConnectDone()
}

func (l *Link) candidateActionPump() (*candidateexchange.ActionPump, error) {
	if l == nil {
		return nil, errors.New("device-link mobile participant is unavailable")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return nil, errors.New("device-link mobile session is closed")
	}
	if l.candidatePump == nil {
		return nil, errors.New("device-link local description has not started")
	}
	return l.candidatePump, nil
}

func encodeLocalDescription(description authenticated.Description) (string, error) {
	description.Candidates = append([]string{}, description.Candidates...)
	raw, err := json.Marshal(description)
	if err != nil {
		return "", fmt.Errorf("encode device-link local description: %w", err)
	}
	return string(raw), nil
}

func (l *Link) openStreamContext(ctx context.Context) (net.Conn, error) {
	connected, err := l.waitConnected(ctx)
	if err != nil {
		return nil, err
	}
	stream, err := connected.OpenStream(ctx)
	if err != nil {
		return nil, err
	}
	if err := devicelink.ProbeStream(ctx, stream); err != nil {
		_ = stream.Close()
		return nil, fmt.Errorf("probe direct stream: %w", err)
	}
	return stream, nil
}

func (l *Link) waitConnected(ctx context.Context) (*authenticated.Link, error) {
	if l == nil {
		return nil, errors.New("device-link mobile participant is unavailable")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	l.mu.Lock()
	connected := l.connected
	closed := l.closed
	connectDone := l.connectDone
	connectErr := l.connectErr
	l.mu.Unlock()
	if closed {
		return nil, errors.New("device-link mobile session is closed")
	}
	if connected != nil {
		return connected, nil
	}
	if connectErr != nil {
		return nil, connectErr
	}
	select {
	case <-connectDone:
		l.mu.Lock()
		connected = l.connected
		connectErr = l.connectErr
		closed = l.closed
		l.mu.Unlock()
		if connected != nil {
			return connected, nil
		}
		if connectErr != nil {
			return nil, connectErr
		}
		if closed {
			return nil, errors.New("device-link mobile session is closed")
		}
		return nil, errors.New("device-link mobile session is not connected")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

type Stream struct {
	conn      net.Conn
	transport string
	once      sync.Once
}

func (s *Stream) ReadInto(buffer []byte) int {
	if s == nil || s.conn == nil {
		return -1
	}
	if len(buffer) == 0 || len(buffer) > maxMobileStreamRead {
		return -1
	}
	count, err := s.conn.Read(buffer)
	if count > 0 {
		// Go readers may return final bytes together with io.EOF. The gomobile
		// boundary cannot return both data and an error without losing the data,
		// so the positive byte count always wins for this call.
		return count
	}
	if err != nil {
		return -1
	}
	return 0
}

func (s *Stream) Write(data []byte) (int, error) {
	if s == nil || s.conn == nil {
		return 0, errors.New("device-link mobile stream is closed")
	}
	return s.conn.Write(data)
}

func (s *Stream) SetDeadline(timeoutMillis int64) error {
	if s == nil || s.conn == nil {
		return errors.New("device-link mobile stream is closed")
	}
	return s.conn.SetDeadline(time.Now().Add(linkTimeout(timeoutMillis)))
}

func (s *Stream) Close() error {
	if s == nil {
		return nil
	}
	var closeErr error
	s.once.Do(func() {
		if s.conn != nil {
			closeErr = s.conn.Close()
		}
	})
	return closeErr
}

func linkTimeout(timeoutMillis int64) time.Duration {
	if timeoutMillis <= 0 {
		return defaultLinkTimeout
	}
	return time.Duration(timeoutMillis) * time.Millisecond
}

func decodeRelayValues(raw, name string) (url.Values, error) {
	if strings.TrimSpace(raw) == "" {
		return make(url.Values), nil
	}
	var values map[string][]string
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return nil, fmt.Errorf("decode relay %s: %w", name, err)
	}
	result := make(url.Values, len(values))
	for key, entries := range values {
		key = strings.TrimSpace(key)
		if key == "" {
			return nil, fmt.Errorf("relay %s contains an empty key", name)
		}
		result[key] = append([]string(nil), entries...)
	}
	return result, nil
}
