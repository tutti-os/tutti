package devicelink

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
)

const (
	streamProbeRequest = "tutti-device-link/stream-probe/1"
	streamProbeAck     = "tutti-device-link/stream-probe-ack/1"
	streamProbeNonce   = 16
	streamProbeLimit   = 5 * time.Second
)

var (
	ErrStreamProbeRejected = errors.New("device-link stream probe rejected")
	ErrStreamProbeMismatch = errors.New("device-link stream probe acknowledgement mismatch")
)

// ProbeStream verifies that the authenticated peer can receive and answer a
// fresh stream before the caller commits a direct/Relay race winner. QUIC
// stream allocation alone is not a liveness signal: a stale session may still
// allocate a local stream after its network path has become unusable.
//
// The probe is transport-owned and carries no Agent or product payload. The
// peer must run ServeStreamProbe before handing the stream to its application
// protocol handler. The same stream is left open after the acknowledgement so
// callers can immediately write their application prelude without a second
// race or an ambiguous request retry.
func ProbeStream(ctx context.Context, stream net.Conn) error {
	if stream == nil {
		return errors.New("device-link stream probe requires a stream")
	}
	probeCtx, cancel := streamProbeContext(ctx)
	defer cancel()
	stopClose := closeStreamOnContext(probeCtx, stream)
	defer stopClose()
	if err := setProbeDeadline(probeCtx, stream); err != nil {
		return fmt.Errorf("set device-link stream probe deadline: %w", err)
	}
	defer func() { _ = stream.SetDeadline(time.Time{}) }()

	nonce := make([]byte, streamProbeNonce)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return fmt.Errorf("generate device-link stream probe nonce: %w", err)
	}
	if err := writeProbeMessage(stream, streamProbeRequest, nonce); err != nil {
		return fmt.Errorf("write device-link stream probe: %w", err)
	}
	ack, err := readProbeMessage(stream, streamProbeAck)
	if err != nil {
		return err
	}
	if !equalBytes(ack, nonce) {
		return ErrStreamProbeMismatch
	}
	stopClose()
	cancel()
	_ = stream.SetDeadline(time.Time{})
	return nil
}

// ServeStreamProbe acknowledges one ProbeStream call and then invokes next
// with the same stream. A failed probe never reaches the product handler.
// This keeps application framing and request semantics out of the shared
// transport handshake while still proving that the remote endpoint is alive.
func ServeStreamProbe(
	ctx context.Context,
	stream net.Conn,
	next func(context.Context, net.Conn) error,
) error {
	if stream == nil {
		return errors.New("device-link stream probe requires a stream")
	}
	if next == nil {
		return errors.New("device-link stream probe handler is required")
	}
	probeCtx, cancel := streamProbeContext(ctx)
	defer cancel()
	stopClose := closeStreamOnContext(probeCtx, stream)
	defer stopClose()
	if err := setProbeDeadline(probeCtx, stream); err != nil {
		return fmt.Errorf("set device-link stream probe deadline: %w", err)
	}
	defer func() { _ = stream.SetDeadline(time.Time{}) }()

	nonce, err := readProbeMessage(stream, streamProbeRequest)
	if err != nil {
		return err
	}
	if err := writeProbeMessage(stream, streamProbeAck, nonce); err != nil {
		return fmt.Errorf("write device-link stream probe acknowledgement: %w", err)
	}
	stopClose()
	cancel()
	_ = stream.SetDeadline(time.Time{})
	return next(ctx, stream)
}

func streamProbeContext(ctx context.Context) (context.Context, context.CancelFunc) {
	if ctx == nil {
		ctx = context.Background()
	}
	if _, ok := ctx.Deadline(); ok {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, streamProbeLimit)
}

func closeStreamOnContext(ctx context.Context, stream net.Conn) func() {
	done := make(chan struct{})
	stopped := make(chan struct{})
	var once sync.Once
	go func() {
		defer close(stopped)
		select {
		case <-ctx.Done():
			_ = stream.Close()
		case <-done:
		}
	}()
	return func() {
		once.Do(func() {
			close(done)
			<-stopped
		})
	}
}

func setProbeDeadline(ctx context.Context, stream net.Conn) error {
	deadline, ok := ctx.Deadline()
	if !ok {
		return nil
	}
	return stream.SetDeadline(deadline)
}

func writeProbeMessage(writer io.Writer, kind string, nonce []byte) error {
	if err := writeProbeBytes(writer, []byte(kind)); err != nil {
		return err
	}
	return writeProbeBytes(writer, nonce)
}

func readProbeMessage(reader io.Reader, kind string) ([]byte, error) {
	header := make([]byte, len(kind))
	if _, err := io.ReadFull(reader, header); err != nil {
		return nil, fmt.Errorf("read device-link stream probe header: %w", err)
	}
	if string(header) != kind {
		return nil, ErrStreamProbeRejected
	}
	nonce := make([]byte, streamProbeNonce)
	if _, err := io.ReadFull(reader, nonce); err != nil {
		return nil, fmt.Errorf("read device-link stream probe nonce: %w", err)
	}
	return nonce, nil
}

func writeProbeBytes(writer io.Writer, payload []byte) error {
	for len(payload) > 0 {
		written, err := writer.Write(payload)
		if err != nil {
			return err
		}
		if written <= 0 || written > len(payload) {
			return io.ErrShortWrite
		}
		payload = payload[written:]
	}
	return nil
}

func equalBytes(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
