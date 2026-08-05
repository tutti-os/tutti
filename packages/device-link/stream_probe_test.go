package devicelink

import (
	"context"
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

func TestStreamProbeLeavesVerifiedStreamForApplicationPayload(t *testing.T) {
	t.Parallel()
	server, client := net.Pipe()
	defer client.Close()
	defer server.Close()

	serverDone := make(chan error, 1)
	go func() {
		serverDone <- ServeStreamProbe(context.Background(), server, func(_ context.Context, stream net.Conn) error {
			payload := make([]byte, len("application-payload"))
			if _, err := io.ReadFull(stream, payload); err != nil {
				return err
			}
			if string(payload) != "application-payload" {
				return errors.New("unexpected application payload")
			}
			_, err := stream.Write([]byte("application-ack"))
			return err
		})
	}()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := ProbeStream(ctx, client); err != nil {
		t.Fatalf("ProbeStream() error = %v", err)
	}
	if _, err := client.Write([]byte("application-payload")); err != nil {
		t.Fatalf("write application payload: %v", err)
	}
	ack := make([]byte, len("application-ack"))
	if _, err := io.ReadFull(client, ack); err != nil {
		t.Fatalf("read application acknowledgement: %v", err)
	}
	if string(ack) != "application-ack" {
		t.Fatalf("application acknowledgement = %q", ack)
	}
	if err := <-serverDone; err != nil {
		t.Fatalf("ServeStreamProbe() error = %v", err)
	}
}

func TestStreamProbeCancellationClosesBlockedStream(t *testing.T) {
	t.Parallel()
	server, client := net.Pipe()
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- ProbeStream(ctx, client) }()
	cancel()

	select {
	case err := <-result:
		if err == nil {
			t.Fatal("ProbeStream() succeeded after cancellation")
		}
	case <-time.After(time.Second):
		t.Fatal("ProbeStream() did not observe cancellation")
	}
	_ = client.Close()
}

func TestStreamProbeRejectsUnexpectedRequest(t *testing.T) {
	t.Parallel()
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()

	result := make(chan error, 1)
	go func() {
		result <- ServeStreamProbe(context.Background(), server, func(context.Context, net.Conn) error {
			return nil
		})
	}()
	payload := make([]byte, len(streamProbeRequest))
	copy(payload, "unexpected")
	if _, err := client.Write(payload); err != nil {
		t.Fatalf("write unexpected probe: %v", err)
	}
	select {
	case err := <-result:
		if !errors.Is(err, ErrStreamProbeRejected) {
			t.Fatalf("ServeStreamProbe() error = %v, want rejection", err)
		}
	case <-time.After(time.Second):
		t.Fatal("ServeStreamProbe() did not reject unexpected request")
	}
}
