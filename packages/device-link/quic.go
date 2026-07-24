package devicelink

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	quic "github.com/quic-go/quic-go"
)

const (
	normalCloseCode       quic.ApplicationErrorCode = 0
	normalStreamCloseCode quic.StreamErrorCode      = 0
)

type QUICEndpoint struct {
	conn      net.PacketConn
	transport *quic.Transport
	once      sync.Once
}

func NewQUICEndpoint(conn *net.UDPConn) (*QUICEndpoint, error) {
	if conn == nil {
		return nil, errors.New("device-link QUIC endpoint requires UDP socket")
	}
	return NewQUICEndpointFromPacketConn(conn)
}

// NewQUICEndpointFromPacketConn builds an endpoint over any packet transport,
// e.g. an ICE-selected path adapted by the icequic package. Callers keep the
// direct *net.UDPConn constructor for host-candidate paths.
func NewQUICEndpointFromPacketConn(conn net.PacketConn) (*QUICEndpoint, error) {
	if conn == nil {
		return nil, errors.New("device-link QUIC endpoint requires packet transport")
	}
	return &QUICEndpoint{conn: conn, transport: &quic.Transport{Conn: conn}}, nil
}

func (e *QUICEndpoint) Listen(tlsConfig *tls.Config) (*QUICListener, error) {
	if e == nil || e.transport == nil || tlsConfig == nil {
		return nil, errors.New("device-link QUIC listener configuration is required")
	}
	listener, err := e.transport.Listen(tlsConfig, defaultQUICConfig())
	if err != nil {
		return nil, fmt.Errorf("listen for device-link QUIC: %w", err)
	}
	return &QUICListener{listener: listener}, nil
}

func (e *QUICEndpoint) Dial(ctx context.Context, remote net.Addr, tlsConfig *tls.Config) (*QUICSession, error) {
	if e == nil || e.transport == nil || remote == nil || tlsConfig == nil {
		return nil, errors.New("device-link QUIC dial configuration is required")
	}
	dialCtx, cancel := context.WithTimeout(ctx, defaultHandshakeTimeout)
	defer cancel()
	connection, err := e.transport.Dial(dialCtx, remote, tlsConfig, defaultQUICConfig())
	if err != nil {
		return nil, fmt.Errorf("dial device-link QUIC: %w", err)
	}
	return &QUICSession{conn: connection}, nil
}

func (e *QUICEndpoint) Close() error {
	if e == nil {
		return nil
	}
	var err error
	e.once.Do(func() {
		var transportErr error
		if e.transport != nil {
			transportErr = e.transport.Close()
		}
		var socketErr error
		if e.conn != nil {
			socketErr = e.conn.Close()
		}
		err = errors.Join(transportErr, socketErr)
	})
	return err
}

type QUICListener struct {
	listener *quic.Listener
}

func (l *QUICListener) Accept(ctx context.Context) (*QUICSession, error) {
	if l == nil || l.listener == nil {
		return nil, errors.New("device-link QUIC listener is closed")
	}
	connection, err := l.listener.Accept(ctx)
	if err != nil {
		return nil, err
	}
	return &QUICSession{conn: connection}, nil
}

func (l *QUICListener) Close() error {
	if l == nil || l.listener == nil {
		return nil
	}
	return l.listener.Close()
}

type QUICSession struct {
	conn *quic.Conn
}

func (s *QUICSession) OpenStream(ctx context.Context) (net.Conn, error) {
	if s == nil || s.conn == nil {
		return nil, errors.New("device-link QUIC session is closed")
	}
	stream, err := s.conn.OpenStreamSync(ctx)
	if err != nil {
		return nil, err
	}
	return &quicStreamConn{stream: stream, session: s.conn}, nil
}

func (s *QUICSession) AcceptStream(ctx context.Context) (net.Conn, error) {
	if s == nil || s.conn == nil {
		return nil, errors.New("device-link QUIC session is closed")
	}
	stream, err := s.conn.AcceptStream(ctx)
	if err != nil {
		return nil, err
	}
	return &quicStreamConn{stream: stream, session: s.conn}, nil
}

func (s *QUICSession) Close() error {
	if s == nil || s.conn == nil {
		return nil
	}
	return s.conn.CloseWithError(normalCloseCode, "closed")
}

func defaultQUICConfig() *quic.Config {
	return &quic.Config{
		HandshakeIdleTimeout: defaultHandshakeTimeout,
		MaxIdleTimeout:       defaultIdleTimeout,
		KeepAlivePeriod:      defaultKeepAlive,
		MaxIncomingStreams:   32,
		EnableDatagrams:      false,
	}
}

type quicStreamConn struct {
	stream  *quic.Stream
	session *quic.Conn
	once    sync.Once
}

func (c *quicStreamConn) Read(p []byte) (int, error)         { return c.stream.Read(p) }
func (c *quicStreamConn) Write(p []byte) (int, error)        { return c.stream.Write(p) }
func (c *quicStreamConn) LocalAddr() net.Addr                { return c.session.LocalAddr() }
func (c *quicStreamConn) RemoteAddr() net.Addr               { return c.session.RemoteAddr() }
func (c *quicStreamConn) SetDeadline(t time.Time) error      { return c.stream.SetDeadline(t) }
func (c *quicStreamConn) SetReadDeadline(t time.Time) error  { return c.stream.SetReadDeadline(t) }
func (c *quicStreamConn) SetWriteDeadline(t time.Time) error { return c.stream.SetWriteDeadline(t) }

func (c *quicStreamConn) Close() error {
	if c == nil || c.stream == nil {
		return nil
	}
	var err error
	c.once.Do(func() {
		c.stream.CancelRead(normalStreamCloseCode)
		err = c.stream.Close()
	})
	return err
}
