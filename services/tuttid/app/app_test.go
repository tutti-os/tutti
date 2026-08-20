package app

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"
)

func TestRunWaitsForActiveRequestShutdownBeforeReturning(t *testing.T) {
	requestStarted := make(chan struct{})
	releaseRequest := make(chan struct{})
	var releaseRequestOnce sync.Once
	release := func() { releaseRequestOnce.Do(func() { close(releaseRequest) }) }
	shutdownStarted := make(chan struct{})
	server := &http.Server{Handler: http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		close(requestStarted)
		<-releaseRequest
	})}
	server.RegisterOnShutdown(func() { close(shutdownStarted) })
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		release()
		_ = listener.Close()
	})
	app := New(server, listener, "")
	app.ShutdownTimeout = 5 * time.Second
	app.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	runDone := make(chan error, 1)
	go func() { runDone <- app.Run(ctx) }()

	responseDone := make(chan error, 1)
	go func() {
		response, requestErr := http.Get("http://" + listener.Addr().String())
		if response != nil {
			_ = response.Body.Close()
		}
		responseDone <- requestErr
	}()
	waitForTestChannel(t, requestStarted, "request to start")
	cancel()
	waitForTestChannel(t, shutdownStarted, "server shutdown to start")

	select {
	case err := <-runDone:
		t.Fatalf("Run returned before the active request drained: %v", err)
	default:
	}
	release()
	if err := waitForTestChannel(t, responseDone, "request to finish"); err != nil {
		t.Fatal(err)
	}
	if err := waitForTestChannel(t, runDone, "Run to return"); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
}

func waitForTestChannel[T any](t *testing.T, channel <-chan T, description string) T {
	t.Helper()
	select {
	case value := <-channel:
		return value
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", description)
		var zero T
		return zero
	}
}
