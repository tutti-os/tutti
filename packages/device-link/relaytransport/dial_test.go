package relaytransport

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

const testSubprotocol = "tutti.relay.owner.test.v1"

func TestDialCreatesAuthenticatedBinaryByteStream(t *testing.T) {
	serverErrors := make(chan error, 1)
	upgrader := websocket.Upgrader{
		CheckOrigin:  func(*http.Request) bool { return true },
		Subprotocols: []string{testSubprotocol},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("authority_id"); got != "device-1" {
			serverErrors <- errors.New("authority_id query was not forwarded")
			return
		}
		if got := r.URL.Query().Get("preserved"); got != "yes" {
			serverErrors <- errors.New("endpoint query was not preserved")
			return
		}
		if got := r.URL.Query()["opaque"]; len(got) != 2 || got[0] != " signed value " || got[1] != "" {
			serverErrors <- errors.New("opaque repeated query values were changed")
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer owner-token" {
			serverErrors <- errors.New("authorization header was not forwarded")
			return
		}
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			serverErrors <- err
			return
		}
		defer ws.Close()
		if err := ws.WriteMessage(websocket.TextMessage, []byte("ignored")); err != nil {
			serverErrors <- err
			return
		}
		if err := ws.WriteMessage(websocket.BinaryMessage, []byte("abcdef")); err != nil {
			serverErrors <- err
			return
		}
		messageType, payload, err := ws.ReadMessage()
		if err != nil {
			serverErrors <- err
			return
		}
		if messageType != websocket.BinaryMessage || !bytes.Equal(payload, []byte("reply")) {
			serverErrors <- errors.New("client did not write one binary message")
			return
		}
		serverErrors <- nil
	}))
	defer server.Close()

	endpoint, err := url.Parse(server.URL + "?preserved=yes")
	if err != nil {
		t.Fatal(err)
	}
	endpoint.Scheme = "ws"
	header := http.Header{"Authorization": []string{"Bearer owner-token"}}
	query := url.Values{
		"authority_id": []string{"device-1"},
		"opaque":       []string{" signed value ", ""},
	}
	conn, err := Dial(context.Background(), DialRequest{
		Endpoint: endpoint.String(), Query: query, Header: header, Subprotocol: testSubprotocol,
	})
	if err != nil {
		t.Fatalf("Dial() error = %v", err)
	}
	defer conn.Close()

	// Mutating caller-owned collections after Dial must not affect the handshake.
	header.Set("Authorization", "mutated")
	query.Set("authority_id", "mutated")
	first := make([]byte, 2)
	if _, err := io.ReadFull(conn, first); err != nil {
		t.Fatalf("first stream read: %v", err)
	}
	second := make([]byte, 4)
	if _, err := io.ReadFull(conn, second); err != nil {
		t.Fatalf("second stream read: %v", err)
	}
	if got := string(append(first, second...)); got != "abcdef" {
		t.Fatalf("stream payload = %q, want abcdef", got)
	}
	if _, err := conn.Write([]byte("reply")); err != nil {
		t.Fatalf("stream write: %v", err)
	}
	select {
	case err := <-serverErrors:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server did not finish the binary stream exchange")
	}
}

func TestDialClosesStreamWhenPeerDoesNotPong(t *testing.T) {
	pings := make(chan struct{}, 1)
	upgrader := websocket.Upgrader{
		CheckOrigin:  func(*http.Request) bool { return true },
		Subprotocols: []string{testSubprotocol},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		ws.SetPingHandler(func(string) error {
			select {
			case pings <- struct{}{}:
			default:
			}
			return nil
		})
		for {
			if _, _, err := ws.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer server.Close()

	endpoint := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, err := Dial(context.Background(), DialRequest{
		Endpoint: endpoint, Subprotocol: testSubprotocol,
		Liveness: DialLivenessConfig{
			PingInterval: 50 * time.Millisecond,
			PongTimeout:  500 * time.Millisecond,
		},
	})
	if err != nil {
		t.Fatalf("Dial() error = %v", err)
	}
	defer conn.Close()

	readResult := make(chan error, 1)
	go func() {
		_, err := conn.Read(make([]byte, 1))
		readResult <- err
	}()

	select {
	case <-pings:
	case <-time.After(2 * time.Second):
		t.Fatal("caller did not send a liveness ping")
	}
	select {
	case err := <-readResult:
		if err == nil {
			t.Fatal("stream read succeeded after peer ignored liveness ping")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stream read remained blocked after peer ignored liveness ping")
	}
}

func TestDialKeepsStreamOpenWhenPeerPongs(t *testing.T) {
	upgrader := websocket.Upgrader{
		CheckOrigin:  func(*http.Request) bool { return true },
		Subprotocols: []string{testSubprotocol},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		pings := 0
		ws.SetPingHandler(func(payload string) error {
			pings++
			if err := ws.WriteControl(websocket.PongMessage, []byte(payload), time.Now().Add(time.Second)); err != nil {
				return err
			}
			if pings == 6 {
				return ws.WriteMessage(websocket.BinaryMessage, []byte("ok"))
			}
			return nil
		})
		for {
			if _, _, err := ws.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer server.Close()

	endpoint := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, err := Dial(context.Background(), DialRequest{
		Endpoint: endpoint, Subprotocol: testSubprotocol,
		Liveness: DialLivenessConfig{
			PingInterval: 100 * time.Millisecond,
			PongTimeout:  500 * time.Millisecond,
		},
	})
	if err != nil {
		t.Fatalf("Dial() error = %v", err)
	}
	defer conn.Close()

	readResult := make(chan struct {
		payload []byte
		err     error
	}, 1)
	go func() {
		payload := make([]byte, 2)
		_, err := io.ReadFull(conn, payload)
		readResult <- struct {
			payload []byte
			err     error
		}{payload: payload, err: err}
	}()

	select {
	case result := <-readResult:
		if result.err != nil {
			t.Fatalf("stream read after pongs: %v", result.err)
		}
		if got := string(result.payload); got != "ok" {
			t.Fatalf("stream payload = %q, want ok", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stream did not remain open while peer replied to liveness pings")
	}
}

func TestDialLivenessDoesNotOverrideCallerReadDeadline(t *testing.T) {
	pings := make(chan struct{}, 1)
	upgrader := websocket.Upgrader{
		CheckOrigin:  func(*http.Request) bool { return true },
		Subprotocols: []string{testSubprotocol},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		ws.SetPingHandler(func(payload string) error {
			if err := ws.WriteControl(websocket.PongMessage, []byte(payload), time.Now().Add(time.Second)); err != nil {
				return err
			}
			select {
			case pings <- struct{}{}:
			default:
			}
			return nil
		})
		for {
			if _, _, err := ws.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer server.Close()

	endpoint := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, err := Dial(context.Background(), DialRequest{
		Endpoint: endpoint, Subprotocol: testSubprotocol,
		Liveness: DialLivenessConfig{
			PingInterval: 50 * time.Millisecond,
			PongTimeout:  500 * time.Millisecond,
		},
	})
	if err != nil {
		t.Fatalf("Dial() error = %v", err)
	}
	defer conn.Close()

	readResult := make(chan error, 1)
	go func() {
		_, err := conn.Read(make([]byte, 1))
		readResult <- err
	}()
	select {
	case <-pings:
	case <-time.After(2 * time.Second):
		t.Fatal("caller did not send a liveness ping")
	}
	if err := conn.SetReadDeadline(time.Now().Add(120 * time.Millisecond)); err != nil {
		t.Fatalf("SetReadDeadline() error = %v", err)
	}
	select {
	case err := <-readResult:
		var netErr net.Error
		if !errors.As(err, &netErr) || !netErr.Timeout() {
			t.Fatalf("stream read error = %v, want caller read deadline timeout", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("liveness pong extended the caller read deadline")
	}
}

func TestDialRejectsUnsafeOrIncompleteRequests(t *testing.T) {
	tests := []struct {
		name    string
		request DialRequest
		want    string
	}{
		{name: "HTTP scheme", request: DialRequest{Endpoint: "https://relay.example/owner", Subprotocol: testSubprotocol}, want: "not ws or wss"},
		{name: "missing host", request: DialRequest{Endpoint: "ws:///owner", Subprotocol: testSubprotocol}, want: "host is empty"},
		{name: "userinfo", request: DialRequest{Endpoint: "wss://secret@relay.example/owner", Subprotocol: testSubprotocol}, want: "userinfo is not allowed"},
		{name: "missing subprotocol", request: DialRequest{Endpoint: "wss://relay.example/owner"}, want: "subprotocol is required"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Dial(context.Background(), tt.request)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("Dial() error = %v, want containing %q", err, tt.want)
			}
		})
	}
}

func TestDialRejectsWrongNegotiatedSubprotocol(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err == nil {
			defer ws.Close()
			time.Sleep(20 * time.Millisecond)
		}
	}))
	defer server.Close()

	endpoint := "ws" + strings.TrimPrefix(server.URL, "http")
	_, err := Dial(context.Background(), DialRequest{Endpoint: endpoint, Subprotocol: testSubprotocol})
	if err == nil || !strings.Contains(err.Error(), "requires subprotocol") {
		t.Fatalf("Dial() error = %v, want negotiated subprotocol error", err)
	}
}

func TestDialErrorClosesResponseBodyAndPreservesRetryMetadata(t *testing.T) {
	body := &trackingReadCloser{Reader: strings.NewReader(`{"reason":"authority_offline"}`)}
	cause := errors.New("handshake rejected")
	err := newDialError(&http.Response{
		StatusCode: http.StatusServiceUnavailable,
		Header:     http.Header{"Retry-After": []string{" 12 "}},
		Body:       body,
	}, cause)

	var dialErr *DialError
	if !errors.As(err, &dialErr) {
		t.Fatalf("newDialError() = %T, want *DialError", err)
	}
	if !errors.Is(err, cause) {
		t.Fatal("DialError does not unwrap the handshake error")
	}
	if !body.closed {
		t.Fatal("response body was not closed")
	}
	if dialErr.HTTPStatusCode() != http.StatusServiceUnavailable || dialErr.HTTPRetryAfter() != "12" {
		t.Fatalf("retry metadata = (%d, %q), want (503, 12)", dialErr.HTTPStatusCode(), dialErr.HTTPRetryAfter())
	}
	if got := string(dialErr.HTTPResponseBody()); got != `{"reason":"authority_offline"}` {
		t.Fatalf("response body = %q, want product reason", got)
	}
	if strings.Contains(err.Error(), "authority_offline") {
		t.Fatal("DialError.Error() exposed the raw response body")
	}
	first := dialErr.HTTPResponseBody()
	first[0] = 'x'
	if got := string(dialErr.HTTPResponseBody()); got != `{"reason":"authority_offline"}` {
		t.Fatal("HTTPResponseBody() exposed mutable internal storage")
	}
}

func TestDialErrorBoundsHandshakeResponseBody(t *testing.T) {
	body := &trackingReadCloser{Reader: strings.NewReader(strings.Repeat("x", maxHandshakeErrorBody+1))}
	err := newDialError(&http.Response{
		StatusCode: http.StatusConflict,
		Header:     make(http.Header),
		Body:       body,
	}, errors.New("handshake rejected"))

	var dialErr *DialError
	if !errors.As(err, &dialErr) {
		t.Fatalf("newDialError() = %T, want *DialError", err)
	}
	if got := len(dialErr.HTTPResponseBody()); got != maxHandshakeErrorBody {
		t.Fatalf("bounded response body length = %d, want %d", got, maxHandshakeErrorBody)
	}
	if !dialErr.HTTPResponseBodyTruncated() {
		t.Fatal("oversized response body was not marked truncated")
	}
	if !body.closed {
		t.Fatal("oversized response body was not closed")
	}
}

type trackingReadCloser struct {
	io.Reader
	closed bool
}

func (r *trackingReadCloser) Close() error {
	r.closed = true
	return nil
}
