package linkmanager

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"
)

type DialFunc func(context.Context) (net.Conn, error)

type DialPath struct {
	Name string
	Dial DialFunc
}

type RaceOutcome string

const (
	RaceStarted  RaceOutcome = "started"
	RaceSelected RaceOutcome = "selected"
	RaceFailed   RaceOutcome = "failed"
	RaceCanceled RaceOutcome = "canceled"
)

type RaceEvent struct {
	Outcome RaceOutcome
	Path    string
	Elapsed time.Duration
}

type RaceObserver func(RaceEvent)

type RaceConfig struct {
	Primary       DialPath
	Fallback      DialPath
	FallbackDelay time.Duration
	Observe       RaceObserver
}

type RaceResult struct {
	Conn net.Conn
	Path string
}

type dialResult struct {
	path string
	conn net.Conn
	err  error
}

// Race starts the primary authenticated-stream dial immediately and starts the
// fallback after FallbackDelay or as soon as the primary fails. The first
// successful stream wins; every late successful stream is closed.
//
// Both dialers receive a child context canceled when the race settles. A
// product that intentionally wants a losing probe to continue for reachability
// learning may detach that dial inside its DialFunc and apply its own deadline.
func Race(ctx context.Context, cfg RaceConfig) (RaceResult, error) {
	primary, fallback, err := validateRacePaths(cfg.Primary, cfg.Fallback)
	if err != nil {
		return RaceResult{}, err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if cfg.FallbackDelay < 0 {
		cfg.FallbackDelay = 0
	}
	startedAt := time.Now()
	observe := func(outcome RaceOutcome, path string) {
		if cfg.Observe != nil {
			cfg.Observe(RaceEvent{Outcome: outcome, Path: path, Elapsed: time.Since(startedAt)})
		}
	}
	observe(RaceStarted, primary.Name)

	dialCtx, cancel := context.WithCancel(ctx)
	settled := make(chan struct{})
	results := make(chan dialResult)
	start := func(path DialPath) {
		go func() {
			conn, dialErr := path.Dial(dialCtx)
			result := dialResult{path: path.Name, conn: conn, err: dialErr}
			select {
			case results <- result:
			case <-settled:
				if conn != nil {
					_ = conn.Close()
				}
			}
		}()
	}
	var settleOnce sync.Once
	settle := func() {
		settleOnce.Do(func() {
			cancel()
			close(settled)
		})
	}
	start(primary)
	started, completed := 1, 0
	fallbackStarted := false
	errs := make(map[string]error, 2)
	timer := time.NewTimer(cfg.FallbackDelay)
	defer timer.Stop()
	startFallback := func() {
		if fallbackStarted {
			return
		}
		fallbackStarted = true
		started++
		observe(RaceStarted, fallback.Name)
		start(fallback)
	}
	if cfg.FallbackDelay == 0 {
		if !timer.Stop() {
			<-timer.C
		}
		startFallback()
	}

	for {
		select {
		case <-ctx.Done():
			settle()
			observe(RaceCanceled, "")
			return RaceResult{}, ctx.Err()
		case <-timer.C:
			startFallback()
		case result := <-results:
			completed++
			if result.err == nil && result.conn != nil {
				settle()
				observe(RaceSelected, result.path)
				return RaceResult{Conn: result.conn, Path: result.path}, nil
			}
			if result.conn != nil {
				_ = result.conn.Close()
			}
			if result.err == nil {
				result.err = errors.New("dialer returned no stream")
			}
			errs[result.path] = result.err
			if result.path == primary.Name && !fallbackStarted {
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				startFallback()
			}
			if fallbackStarted && completed == started {
				settle()
				observe(RaceFailed, "")
				return RaceResult{}, fmt.Errorf(
					"device-link paths %q and %q failed: %w",
					primary.Name,
					fallback.Name,
					errors.Join(errs[primary.Name], errs[fallback.Name]),
				)
			}
		}
	}
}

func validateRacePaths(primary, fallback DialPath) (DialPath, DialPath, error) {
	primary.Name = strings.TrimSpace(primary.Name)
	fallback.Name = strings.TrimSpace(fallback.Name)
	if primary.Name == "" || fallback.Name == "" {
		return DialPath{}, DialPath{}, errors.New("device-link race paths require names")
	}
	if primary.Name == fallback.Name {
		return DialPath{}, DialPath{}, errors.New("device-link race paths require distinct names")
	}
	if primary.Dial == nil || fallback.Dial == nil {
		return DialPath{}, DialPath{}, errors.New("device-link race paths require dialers")
	}
	return primary, fallback, nil
}
