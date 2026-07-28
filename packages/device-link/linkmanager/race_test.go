package linkmanager

import (
	"context"
	"errors"
	"net"
	"sync/atomic"
	"testing"
	"time"
)

func TestRaceSelectsPrimaryBeforeFallbackDelay(t *testing.T) {
	t.Parallel()
	primary, primaryPeer := net.Pipe()
	defer primaryPeer.Close()
	var fallbackCalls atomic.Int32
	result, err := Race(context.Background(), RaceConfig{
		Primary: DialPath{Name: "preferred", Dial: func(context.Context) (net.Conn, error) {
			return primary, nil
		}},
		Fallback: DialPath{Name: "fallback", Dial: func(context.Context) (net.Conn, error) {
			fallbackCalls.Add(1)
			return nil, errors.New("unexpected fallback")
		}},
		FallbackDelay: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer result.Conn.Close()
	if result.Path != "preferred" {
		t.Fatalf("selected path = %q, want preferred", result.Path)
	}
	if fallbackCalls.Load() != 0 {
		t.Fatalf("fallback calls = %d, want 0", fallbackCalls.Load())
	}
}

func TestRaceStartsFallbackImmediatelyAfterPrimaryFailure(t *testing.T) {
	t.Parallel()
	fallback, fallbackPeer := net.Pipe()
	defer fallbackPeer.Close()
	started := time.Now()
	result, err := Race(context.Background(), RaceConfig{
		Primary: DialPath{Name: "preferred", Dial: func(context.Context) (net.Conn, error) {
			return nil, errors.New("preferred unavailable")
		}},
		Fallback: DialPath{Name: "fallback", Dial: func(context.Context) (net.Conn, error) {
			return fallback, nil
		}},
		FallbackDelay: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer result.Conn.Close()
	if result.Path != "fallback" {
		t.Fatalf("selected path = %q, want fallback", result.Path)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("fast failure waited %s for fallback", elapsed)
	}
}

func TestRaceClosesLateSuccessfulConnection(t *testing.T) {
	t.Parallel()
	releasePrimary := make(chan struct{})
	late := newTrackingConn()
	fallback := newTrackingConn()
	result, err := Race(context.Background(), RaceConfig{
		Primary: DialPath{Name: "preferred", Dial: func(context.Context) (net.Conn, error) {
			<-releasePrimary
			return late, nil
		}},
		Fallback: DialPath{Name: "fallback", Dial: func(context.Context) (net.Conn, error) {
			return fallback, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Path != "fallback" {
		t.Fatalf("selected path = %q, want fallback", result.Path)
	}
	close(releasePrimary)
	deadline := time.Now().Add(time.Second)
	for late.closeCount.Load() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("late successful connection was not closed")
		}
		time.Sleep(time.Millisecond)
	}
	_ = result.Conn.Close()
}

func TestRaceJoinsBothFailures(t *testing.T) {
	t.Parallel()
	_, err := Race(context.Background(), RaceConfig{
		Primary: DialPath{Name: "preferred", Dial: func(context.Context) (net.Conn, error) {
			return nil, errors.New("preferred failure")
		}},
		Fallback: DialPath{Name: "fallback", Dial: func(context.Context) (net.Conn, error) {
			return nil, nil
		}},
	})
	if err == nil {
		t.Fatal("Race succeeded when both paths failed")
	}
}
