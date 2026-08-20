package connectorcontrolplane

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
	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

const (
	connectorAuthorizationChangedEvent = "connector.authorization.changed"
	connectorRealtimeProtocolVersion   = 2
	connectorRealtimeHeartbeat         = 3 * time.Minute
	connectorRealtimeDefaultURL        = "wss://ws.tutti.sh/"
)

type AuthorizationEventSourceConfig struct {
	URL               string
	DeviceID          string
	HeadersForAccount func(string) (http.Header, error)
}

type AuthorizationEventSource struct {
	url               string
	deviceID          string
	headersForAccount func(string) (http.Header, error)
}

func NewAuthorizationEventSource(config AuthorizationEventSourceConfig) (*AuthorizationEventSource, error) {
	if strings.TrimSpace(config.DeviceID) == "" || config.HeadersForAccount == nil {
		return nil, errors.New("connector authorization realtime device and account cookie are required")
	}
	endpoint, err := connectorRealtimeEndpoint(config.URL, config.DeviceID)
	if err != nil {
		return nil, err
	}
	return &AuthorizationEventSource{url: endpoint, deviceID: strings.TrimSpace(config.DeviceID), headersForAccount: config.HeadersForAccount}, nil
}

func (source *AuthorizationEventSource) RunAuthorizationEvents(ctx context.Context, accountID string, notify func()) error {
	if source == nil || notify == nil {
		return errors.New("connector authorization realtime listener is unavailable")
	}
	headers, err := source.headersForAccount(strings.TrimSpace(accountID))
	if err != nil {
		return err
	}
	connectionCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	conn, _, err := websocket.Dial(connectionCtx, source.url, &websocket.DialOptions{HTTPHeader: headers.Clone()})
	if err != nil {
		return err
	}
	defer conn.Close(websocket.StatusNormalClosure, "connector authorization listener stopped")
	conn.SetReadLimit(16 * 1024)
	if err := writeConnectorRealtimeAction(connectionCtx, conn, "connection.initialize", map[string]any{"protocolVersion": connectorRealtimeProtocolVersion}); err != nil {
		return err
	}
	if err := writeConnectorRealtimeAction(connectionCtx, conn, "init", map[string]any{"deviceId": source.deviceID}); err != nil {
		return err
	}
	heartbeat := time.NewTicker(connectorRealtimeHeartbeat)
	defer heartbeat.Stop()
	go func() {
		for {
			select {
			case <-connectionCtx.Done():
				return
			case now := <-heartbeat.C:
				_ = writeConnectorRealtimeAction(connectionCtx, conn, "ping", map[string]any{"ts": now.UnixMilli()})
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
		if isConnectorAuthorizationChanged(raw) {
			notify()
		}
	}
}

func isConnectorAuthorizationChanged(raw []byte) bool {
	var envelope struct {
		ProtocolVersion int             `json:"protocol_version"`
		Type            string          `json:"type"`
		EventType       string          `json:"event_type"`
		Payload         json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil || envelope.ProtocolVersion != connectorRealtimeProtocolVersion {
		return false
	}
	eventType := strings.TrimSpace(envelope.EventType)
	if eventType == "" {
		eventType = strings.TrimSpace(envelope.Type)
	}
	if eventType != connectorAuthorizationChangedEvent {
		return false
	}
	payload := envelope.Payload
	if len(payload) > 0 && payload[0] == '"' {
		var encoded string
		if json.Unmarshal(payload, &encoded) != nil {
			return false
		}
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return false
		}
		payload = decoded
	}
	var change struct {
		Revision uint64 `json:"revision"`
	}
	return json.Unmarshal(payload, &change) == nil && change.Revision > 0
}

func writeConnectorRealtimeAction(ctx context.Context, conn *websocket.Conn, action string, data map[string]any) error {
	payload, err := json.Marshal(struct {
		Action string         `json:"action"`
		Data   map[string]any `json:"data"`
	}{Action: action, Data: data})
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, payload)
}

func connectorRealtimeEndpoint(rawURL, deviceID string) (string, error) {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		rawURL = connectorRealtimeDefaultURL
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" || parsed.Scheme != "ws" && parsed.Scheme != "wss" {
		return "", errors.New("connector authorization realtime URL is invalid")
	}
	query := parsed.Query()
	query.Set("deviceId", strings.TrimSpace(deviceID))
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

var _ market.AuthorizationEventSource = (*AuthorizationEventSource)(nil)
