package relaytransport

import (
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const (
	defaultDialPingInterval = 20 * time.Second
	defaultDialPongTimeout  = 60 * time.Second
)

type dialWebSocketByteConn struct {
	*websocketByteConn

	stopLiveness func()
	closeOnce    sync.Once
	closeErr     error
}

func newDialWebSocketByteConn(ws *websocket.Conn, config DialLivenessConfig) net.Conn {
	return &dialWebSocketByteConn{
		websocketByteConn: newWebSocketByteConn(ws),
		stopLiveness:      startDialLiveness(ws, normalizeDialLiveness(config)),
	}
}

func (c *dialWebSocketByteConn) Close() error {
	c.closeOnce.Do(func() {
		c.closeErr = c.websocketByteConn.Close()
		c.stopLiveness()
	})
	return c.closeErr
}

func normalizeDialLiveness(config DialLivenessConfig) DialLivenessConfig {
	if config.PingInterval <= 0 {
		config.PingInterval = defaultDialPingInterval
	}
	if config.PongTimeout <= config.PingInterval {
		config.PongTimeout = config.PingInterval * 3
	}
	return config
}

func startDialLiveness(ws *websocket.Conn, config DialLivenessConfig) func() {
	var lastPongUnixNano atomic.Int64
	lastPongUnixNano.Store(time.Now().UnixNano())
	pongs := make(chan struct{}, 1)
	ws.SetPongHandler(func(string) error {
		lastPongUnixNano.Store(time.Now().UnixNano())
		select {
		case pongs <- struct{}{}:
		default:
		}
		return nil
	})

	done := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(config.PingInterval)
		defer ticker.Stop()
		timeout := time.NewTimer(config.PongTimeout)
		defer timeout.Stop()

		for {
			select {
			case <-done:
				return
			case <-pongs:
				resetTimer(timeout, config.PongTimeout)
			case <-ticker.C:
				if err := ws.WriteControl(websocket.PingMessage, []byte("caller"), time.Now().Add(time.Second)); err != nil {
					_ = ws.Close()
					return
				}
			case <-timeout.C:
				lastPongAt := time.Unix(0, lastPongUnixNano.Load())
				remaining := config.PongTimeout - time.Since(lastPongAt)
				if remaining > 0 {
					timeout.Reset(remaining)
					continue
				}
				_ = ws.Close()
				return
			}
		}
	}()

	var once sync.Once
	return func() {
		once.Do(func() {
			close(done)
			<-stopped
		})
	}
}

func resetTimer(timer *time.Timer, duration time.Duration) {
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
	timer.Reset(duration)
}
