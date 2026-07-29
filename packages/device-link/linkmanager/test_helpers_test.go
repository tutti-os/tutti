package linkmanager

import (
	"context"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

type trackingConn struct {
	closeCount atomic.Int32
}

func newTrackingConn() *trackingConn {
	return &trackingConn{}
}

func (*trackingConn) Read([]byte) (int, error)         { return 0, io.EOF }
func (*trackingConn) Write(p []byte) (int, error)      { return len(p), nil }
func (*trackingConn) LocalAddr() net.Addr              { return testAddr("local") }
func (*trackingConn) RemoteAddr() net.Addr             { return testAddr("remote") }
func (*trackingConn) SetDeadline(time.Time) error      { return nil }
func (*trackingConn) SetReadDeadline(time.Time) error  { return nil }
func (*trackingConn) SetWriteDeadline(time.Time) error { return nil }
func (c *trackingConn) Close() error {
	c.closeCount.Add(1)
	return nil
}

type testAddr string

func (testAddr) Network() string        { return "test" }
func (address testAddr) String() string { return string(address) }

type fakeLink struct {
	openCount  atomic.Int32
	closeCount atomic.Int32

	incoming chan net.Conn
	closed   chan struct{}
	once     sync.Once
}

type cancelableOpenLink struct {
	*fakeLink
	cancelNext atomic.Bool
}

func (link *cancelableOpenLink) OpenStream(ctx context.Context) (net.Conn, error) {
	if link.cancelNext.CompareAndSwap(true, false) {
		return nil, ctx.Err()
	}
	return link.fakeLink.OpenStream(ctx)
}

func newFakeLink() *fakeLink {
	return &fakeLink{
		incoming: make(chan net.Conn, 8),
		closed:   make(chan struct{}),
	}
}

func (link *fakeLink) OpenStream(context.Context) (net.Conn, error) {
	select {
	case <-link.closed:
		return nil, net.ErrClosed
	default:
	}
	link.openCount.Add(1)
	return newTrackingConn(), nil
}

func (link *fakeLink) AcceptStream(ctx context.Context) (net.Conn, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-link.closed:
		return nil, net.ErrClosed
	case stream := <-link.incoming:
		return stream, nil
	}
}

func (link *fakeLink) Close() error {
	link.once.Do(func() {
		link.closeCount.Add(1)
		close(link.closed)
	})
	return nil
}

func (link *fakeLink) queueIncoming(stream net.Conn) {
	link.incoming <- stream
}
