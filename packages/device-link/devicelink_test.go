package devicelink

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"
)

func TestQUICEndpointCloseClosesOwnedUDPSocket(t *testing.T) {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	endpoint, err := NewQUICEndpoint(conn)
	if err != nil {
		t.Fatal(err)
	}
	if err := endpoint.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if err := conn.SetReadDeadline(time.Now()); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("owned UDP socket deadline error = %v, want net.ErrClosed", err)
	}
}

func TestGlobalIPv6FromAddr(t *testing.T) {
	tests := []struct {
		name string
		addr string
		ok   bool
	}{
		{name: "global", addr: "2001:db8::10/64", ok: true},
		{name: "ula", addr: "fd00::10/64", ok: false},
		{name: "link local", addr: "fe80::10%en0/64", ok: false},
		{name: "ipv4", addr: "192.0.2.10/24", ok: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, ok := globalIPv6FromAddr(testAddr(tt.addr))
			if ok != tt.ok {
				t.Fatalf("globalIPv6FromAddr(%q) ok = %v, want %v", tt.addr, ok, tt.ok)
			}
		})
	}
}

func TestListenGlobalIPv6CurrentHost(t *testing.T) {
	if os.Getenv("TUTTI_TEST_GLOBAL_IPV6") != "1" {
		t.Skip("set TUTTI_TEST_GLOBAL_IPV6=1 to probe physical IPv6 candidates")
	}
	endpoints, err := ListenGlobalIPv6(context.Background())
	if err != nil {
		t.Fatalf("ListenGlobalIPv6() error = %v", err)
	}
	defer func() {
		for _, endpoint := range endpoints {
			_ = endpoint.Close()
		}
	}()
	for _, endpoint := range endpoints {
		if strings.HasPrefix(strings.ToLower(endpoint.Candidate.InterfaceName), "utun") {
			t.Fatalf("ListenGlobalIPv6() returned TUN candidate on %q", endpoint.Candidate.InterfaceName)
		}
	}
}

func TestQUICMutualPinningAndStreamRoundTrip(t *testing.T) {
	callerUDP := listenLoopbackUDP6(t)
	ownerUDP := listenLoopbackUDP6(t)
	runQUICRoundTrip(t, context.Background(), callerUDP, ownerUDP)
}

func runQUICRoundTrip(t *testing.T, parent context.Context, callerUDP, ownerUDP *net.UDPConn) {
	t.Helper()
	callerEndpoint, err := NewQUICEndpoint(callerUDP)
	if err != nil {
		t.Fatal(err)
	}
	defer callerEndpoint.Close()
	ownerEndpoint, err := NewQUICEndpoint(ownerUDP)
	if err != nil {
		t.Fatal(err)
	}
	defer ownerEndpoint.Close()

	callerIdentity, err := NewEphemeralIdentity(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	ownerIdentity, err := NewEphemeralIdentity(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	serverTLS, err := ownerIdentity.ServerTLSConfig(callerIdentity.Fingerprint)
	if err != nil {
		t.Fatal(err)
	}
	clientTLS, err := callerIdentity.ClientTLSConfig(ownerIdentity.Fingerprint)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := ownerEndpoint.Listen(serverTLS)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	serverDone := make(chan error, 1)
	go func() {
		session, err := listener.Accept(ctx)
		if err != nil {
			serverDone <- err
			return
		}
		defer session.Close()
		stream, err := session.AcceptStream(ctx)
		if err != nil {
			serverDone <- err
			return
		}
		defer stream.Close()
		_, err = io.Copy(stream, stream)
		serverDone <- err
	}()

	clientSession, err := callerEndpoint.Dial(ctx, ownerUDP.LocalAddr().(*net.UDPAddr), clientTLS)
	if err != nil {
		t.Fatal(err)
	}
	stream, err := clientSession.OpenStream(ctx)
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte("device-link-quic-round-trip")
	if _, err := stream.Write(payload); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(stream, got); err != nil {
		t.Fatal(err)
	}
	if string(got) != string(payload) {
		t.Fatalf("round trip = %q, want %q", got, payload)
	}
	_ = stream.Close()
	select {
	case err := <-serverDone:
		if err != nil && err != io.EOF {
			t.Fatalf("server error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("server did not finish")
	}
	_ = clientSession.Close()
}

func TestQUICRejectsWrongPeerFingerprint(t *testing.T) {
	identity, err := NewEphemeralIdentity(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	other, err := NewEphemeralIdentity(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	wrong, err := NewEphemeralIdentity(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	config, err := identity.ClientTLSConfig(other.Fingerprint)
	if err != nil {
		t.Fatal(err)
	}
	if err := config.VerifyPeerCertificate(wrong.Certificate.Certificate, nil); err == nil {
		t.Fatal("VerifyPeerCertificate() accepted wrong fingerprint")
	}
}

func listenLoopbackUDP6(t *testing.T) *net.UDPConn {
	t.Helper()
	conn, err := net.ListenUDP("udp6", &net.UDPAddr{IP: net.ParseIP("::1")})
	if err != nil {
		t.Fatalf("ListenUDP() error = %v", err)
	}
	return conn
}

type testAddr string

func (testAddr) Network() string  { return "test" }
func (a testAddr) String() string { return string(a) }
