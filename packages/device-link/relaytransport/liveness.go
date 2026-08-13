package relaytransport

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

type livenessConfig struct {
	pingInterval time.Duration
	pongTimeout  time.Duration
	pingPayload  []byte
	sessionKey   string
	generation   uint64
	observe      OwnerObserver
}

func startLiveness(ctx context.Context, ws *websocket.Conn, cfg livenessConfig) (func(), error) {
	if err := ws.SetReadDeadline(time.Now().Add(cfg.pongTimeout)); err != nil {
		return nil, fmt.Errorf("set relay owner read deadline: %w", err)
	}
	var pingCount atomic.Int64
	var pongCount atomic.Int64
	var lastPongUnixNano atomic.Int64
	ws.SetPongHandler(func(string) error {
		now := time.Now()
		lastPongUnixNano.Store(now.UnixNano())
		pongs := pongCount.Add(1)
		observeLiveness(cfg, OwnerEvent{
			Outcome: OwnerOutcomePongReceived,
			Liveness: &OwnerLivenessObservation{
				PingCount: pingCount.Load(), PongCount: pongs, At: now,
			},
		})
		return ws.SetReadDeadline(now.Add(cfg.pongTimeout))
	})
	payload := append([]byte(nil), cfg.pingPayload...)
	if len(payload) == 0 {
		payload = []byte("owner")
	}

	done := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(cfg.pingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-done:
				return
			case <-ticker.C:
				pings := pingCount.Add(1)
				now := time.Now()
				if err := ws.WriteControl(websocket.PingMessage, payload, now.Add(time.Second)); err != nil {
					observeLiveness(cfg, OwnerEvent{
						Outcome: OwnerOutcomeFailed,
						Liveness: &OwnerLivenessObservation{
							PingCount: pings, PongCount: pongCount.Load(), At: now,
						},
						Error: err,
					})
					_ = ws.Close()
					return
				}
				observeLiveness(cfg, OwnerEvent{
					Outcome: OwnerOutcomePingSent,
					Liveness: &OwnerLivenessObservation{
						PingCount: pings, PongCount: pongCount.Load(), At: now,
					},
				})
			}
		}
	}()

	var once sync.Once
	return func() {
		once.Do(func() {
			close(done)
			<-stopped
			var lastPongAt time.Time
			if unixNano := lastPongUnixNano.Load(); unixNano != 0 {
				lastPongAt = time.Unix(0, unixNano)
			}
			observeLiveness(cfg, OwnerEvent{
				Outcome: OwnerOutcomeStopped,
				Liveness: &OwnerLivenessObservation{
					PingCount: pingCount.Load(), PongCount: pongCount.Load(),
					At: time.Now(), LastPongAt: lastPongAt,
				},
			})
		})
	}, nil
}

func observeLiveness(cfg livenessConfig, event OwnerEvent) {
	if cfg.observe == nil {
		return
	}
	event.Phase = OwnerPhaseLiveness
	event.Generation = cfg.generation
	event.SessionKey = cfg.sessionKey
	cfg.observe(event)
}
