// Package mobile exposes the deliberately small API that gomobile binds for
// the Android DeviceLink vertical slice. Product rendezvous and lifecycle APIs
// will grow here only after the transport probe has proven the native boundary.
package mobile

import (
	"context"
	"fmt"
	"io"
	"time"

	devicelink "github.com/tutti-os/tutti/packages/device-link"
	"github.com/tutti-os/tutti/packages/device-link/icequic"
)

const defaultProbeTimeout = 30 * time.Second

// ProbeEpoch versions only this disposable gomobile integration probe. Product
// application-stream versioning belongs to the consuming host adapter.
func ProbeEpoch() int { return 1 }

// RunLoopbackProbe negotiates an ICE path, runs mutually pinned QUIC over that
// path, opens one stream, and returns the echoed payload. It is a build and
// device integration probe, not a product rendezvous fallback.
func RunLoopbackProbe(timeoutMillis int64) (string, error) {
	timeout := time.Duration(timeoutMillis) * time.Millisecond
	if timeoutMillis <= 0 {
		timeout = defaultProbeTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	caller, err := icequic.NewAgent(icequic.AgentConfig{IncludeLoopback: true})
	if err != nil {
		return "", fmt.Errorf("create caller ICE agent: %w", err)
	}
	defer caller.Close()
	owner, err := icequic.NewAgent(icequic.AgentConfig{IncludeLoopback: true})
	if err != nil {
		return "", fmt.Errorf("create owner ICE agent: %w", err)
	}
	defer owner.Close()

	callerParams, err := caller.LocalParams(ctx)
	if err != nil {
		return "", fmt.Errorf("gather caller ICE params: %w", err)
	}
	ownerParams, err := owner.LocalParams(ctx)
	if err != nil {
		return "", fmt.Errorf("gather owner ICE params: %w", err)
	}

	type pathResult struct {
		conn *icequic.SinglePeerPacketConn
		err  error
	}
	ownerPath := make(chan pathResult, 1)
	go func() {
		conn, connectErr := owner.Connect(
			ctx,
			callerParams.Ufrag,
			callerParams.Pwd,
			callerParams.Candidates,
			false,
		)
		ownerPath <- pathResult{conn: conn, err: connectErr}
	}()
	callerConn, err := caller.Connect(
		ctx,
		ownerParams.Ufrag,
		ownerParams.Pwd,
		ownerParams.Candidates,
		true,
	)
	if err != nil {
		return "", fmt.Errorf("negotiate caller ICE path: %w", err)
	}
	ownerResult := <-ownerPath
	if ownerResult.err != nil {
		return "", fmt.Errorf("negotiate owner ICE path: %w", ownerResult.err)
	}

	callerIdentity, err := devicelink.NewEphemeralIdentity(time.Now())
	if err != nil {
		return "", err
	}
	ownerIdentity, err := devicelink.NewEphemeralIdentity(time.Now())
	if err != nil {
		return "", err
	}

	ownerEndpoint, err := devicelink.NewQUICEndpointFromPacketConn(ownerResult.conn)
	if err != nil {
		return "", err
	}
	defer ownerEndpoint.Close()
	ownerTLS, err := ownerIdentity.ServerTLSConfig(callerIdentity.Fingerprint)
	if err != nil {
		return "", err
	}
	listener, err := ownerEndpoint.Listen(ownerTLS)
	if err != nil {
		return "", err
	}
	defer listener.Close()

	type sessionResult struct {
		session *devicelink.QUICSession
		err     error
	}
	ownerSession := make(chan sessionResult, 1)
	go func() {
		session, acceptErr := listener.Accept(ctx)
		ownerSession <- sessionResult{session: session, err: acceptErr}
	}()

	callerEndpoint, err := devicelink.NewQUICEndpointFromPacketConn(callerConn)
	if err != nil {
		return "", err
	}
	defer callerEndpoint.Close()
	callerTLS, err := callerIdentity.ClientTLSConfig(ownerIdentity.Fingerprint)
	if err != nil {
		return "", err
	}
	callerSession, err := callerEndpoint.Dial(ctx, callerConn.RemoteAddr(), callerTLS)
	if err != nil {
		return "", fmt.Errorf("dial QUIC over ICE: %w", err)
	}
	defer callerSession.Close()
	ownerSessionResult := <-ownerSession
	if ownerSessionResult.err != nil {
		return "", fmt.Errorf("accept QUIC over ICE: %w", ownerSessionResult.err)
	}
	defer ownerSessionResult.session.Close()

	echoDone := make(chan error, 1)
	go func() {
		stream, streamErr := ownerSessionResult.session.AcceptStream(ctx)
		if streamErr != nil {
			echoDone <- streamErr
			return
		}
		defer stream.Close()
		_, copyErr := io.Copy(stream, stream)
		echoDone <- copyErr
	}()

	stream, err := callerSession.OpenStream(ctx)
	if err != nil {
		return "", fmt.Errorf("open probe stream: %w", err)
	}
	payload := []byte("tutti-device-link-android-probe")
	if _, err := stream.Write(payload); err != nil {
		return "", fmt.Errorf("write probe payload: %w", err)
	}
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(stream, got); err != nil {
		return "", fmt.Errorf("read probe echo: %w", err)
	}
	if err := stream.Close(); err != nil {
		return "", fmt.Errorf("close probe stream: %w", err)
	}
	select {
	case err := <-echoDone:
		if err != nil && err != io.EOF {
			return "", fmt.Errorf("serve probe echo: %w", err)
		}
	case <-ctx.Done():
		return "", ctx.Err()
	}
	if string(got) != string(payload) {
		return "", fmt.Errorf("probe echo mismatch")
	}
	return string(got), nil
}
