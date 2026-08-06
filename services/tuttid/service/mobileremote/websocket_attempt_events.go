package mobileremote

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
)

const (
	DefaultRealtimeBaseURL       = "wss://ws.tutti.sh/"
	deviceLinkAttemptChangedType = "device_link.attempt.changed"
	websocketProtocolVersion     = 2
	websocketHeartbeatInterval   = 3 * time.Minute
)

// WebSocketAttemptEvents consumes the account/device-scoped realtime lane.
// It intentionally exposes one connection attempt per Run call; the remote
// host owns reconnect backoff so credentials are refreshed between attempts.
type WebSocketAttemptEvents struct {
	URL string
}

func (s WebSocketAttemptEvents) Run(ctx context.Context, cookie, deviceID string, notify func(string)) error {
	if notify == nil {
		return errors.New("device-link attempt event listener is required")
	}
	endpoint, err := realtimeEndpoint(s.URL, deviceID)
	if err != nil {
		return err
	}
	connectionCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	conn, _, err := websocket.Dial(connectionCtx, endpoint, &websocket.DialOptions{
		HTTPHeader: http.Header{"Cookie": []string{strings.TrimSpace(cookie)}},
	})
	if err != nil {
		return err
	}
	defer conn.Close(websocket.StatusNormalClosure, "device-link attempt listener stopped")
	conn.SetReadLimit(16 * 1024)
	if err := writeRealtimeAction(connectionCtx, conn, "connection.initialize", map[string]any{
		"protocolVersion": websocketProtocolVersion,
	}); err != nil {
		return err
	}
	if err := writeRealtimeAction(connectionCtx, conn, "init", map[string]any{
		"deviceId": deviceID,
	}); err != nil {
		return err
	}

	heartbeat := time.NewTicker(websocketHeartbeatInterval)
	defer heartbeat.Stop()
	go func() {
		for {
			select {
			case <-connectionCtx.Done():
				return
			case now := <-heartbeat.C:
				_ = writeRealtimeAction(connectionCtx, conn, "ping", map[string]any{
					"ts": now.UnixMilli(),
				})
			}
		}
	}()

	for {
		_, raw, err := conn.Read(connectionCtx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if attemptID, ok := parseDeviceLinkAttemptEvent(raw); ok {
			notify(attemptID)
		}
	}
}

type realtimeEnvelope struct {
	ProtocolVersion int             `json:"protocol_version"`
	Type            string          `json:"type"`
	EventType       string          `json:"event_type"`
	Payload         json.RawMessage `json:"payload"`
}

type deviceLinkAttemptChangedPayload struct {
	AttemptID string `json:"attemptId"`
}

func parseDeviceLinkAttemptEvent(raw []byte) (string, bool) {
	var envelope realtimeEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil ||
		envelope.ProtocolVersion != websocketProtocolVersion {
		return "", false
	}
	eventType := strings.TrimSpace(envelope.EventType)
	if eventType == "" {
		eventType = strings.TrimSpace(envelope.Type)
	}
	if eventType != deviceLinkAttemptChangedType {
		return "", false
	}
	payload := envelope.Payload
	if len(payload) > 0 && payload[0] == '"' {
		var encoded string
		if err := json.Unmarshal(payload, &encoded); err != nil {
			return "", false
		}
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return "", false
		}
		payload = decoded
	}
	var attempt deviceLinkAttemptChangedPayload
	if err := json.Unmarshal(payload, &attempt); err != nil {
		return "", false
	}
	attemptID := strings.TrimSpace(attempt.AttemptID)
	return attemptID, attemptID != ""
}

func writeRealtimeAction(ctx context.Context, conn *websocket.Conn, action string, data map[string]any) error {
	payload, err := json.Marshal(struct {
		Action string         `json:"action"`
		Data   map[string]any `json:"data"`
	}{Action: action, Data: data})
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, payload)
}

func realtimeEndpoint(rawURL, deviceID string) (string, error) {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		rawURL = DefaultRealtimeBaseURL
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "ws" && parsed.Scheme != "wss") {
		return "", errors.New("mobile remote realtime URL is invalid")
	}
	deviceID = strings.TrimSpace(deviceID)
	if deviceID == "" {
		return "", errors.New("mobile remote realtime device identity is required")
	}
	query := parsed.Query()
	query.Set("deviceId", deviceID)
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}
