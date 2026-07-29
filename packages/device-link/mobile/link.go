package mobile

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	authenticated "github.com/tutti-os/tutti/packages/device-link/authenticated"
)

const (
	ApplicationProtocolEpoch = 1
	defaultLinkTimeout       = 30 * time.Second
	maxMobileStreamRead      = 1 << 20
)

type Link struct {
	participant *authenticated.Participant

	mu        sync.Mutex
	connected *authenticated.Link
	closed    bool
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
	return &Link{participant: participant}, nil
}

func NewLoopbackLink() (*Link, error) {
	participant, err := authenticated.NewParticipant(authenticated.ParticipantConfig{
		IncludeLoopback: true,
	})
	if err != nil {
		return nil, err
	}
	return &Link{participant: participant}, nil
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
	raw, err := json.Marshal(description)
	if err != nil {
		return "", fmt.Errorf("encode device-link local description: %w", err)
	}
	return string(raw), nil
}

func (l *Link) Connect(peerDescriptionJSON string, caller bool, timeoutMillis int64) (string, error) {
	if l == nil || l.participant == nil {
		return "", errors.New("device-link mobile participant is unavailable")
	}
	var peer authenticated.Description
	if err := json.Unmarshal([]byte(peerDescriptionJSON), &peer); err != nil {
		return "", fmt.Errorf("decode device-link peer description: %w", err)
	}
	role := authenticated.RoleOwner
	if caller {
		role = authenticated.RoleCaller
	}
	ctx, cancel := context.WithTimeout(context.Background(), linkTimeout(timeoutMillis))
	defer cancel()
	connected, err := l.participant.Connect(ctx, peer, role)
	if err != nil {
		return "", err
	}
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		_ = connected.Close()
		return "", errors.New("device-link mobile participant closed while connecting")
	}
	l.connected = connected
	l.mu.Unlock()
	return connected.SelectedScope(), nil
}

func (l *Link) OpenStream(timeoutMillis int64) (*Stream, error) {
	connected, err := l.activeLink()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), linkTimeout(timeoutMillis))
	defer cancel()
	stream, err := connected.OpenStream(ctx)
	if err != nil {
		return nil, err
	}
	return &Stream{conn: stream}, nil
}

func (l *Link) AcceptStream(timeoutMillis int64) (*Stream, error) {
	connected, err := l.activeLink()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), linkTimeout(timeoutMillis))
	defer cancel()
	stream, err := connected.AcceptStream(ctx)
	if err != nil {
		return nil, err
	}
	return &Stream{conn: stream}, nil
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
	l.mu.Unlock()
	if connected != nil {
		return connected.Close()
	}
	if participant != nil {
		return participant.Close()
	}
	return nil
}

func (l *Link) activeLink() (*authenticated.Link, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed || l.connected == nil {
		return nil, errors.New("device-link mobile session is not connected")
	}
	return l.connected, nil
}

type Stream struct {
	conn net.Conn
	once sync.Once
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
