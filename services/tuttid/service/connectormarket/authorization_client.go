package connectormarket

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	market "github.com/tutti-os/tutti/packages/connector/host"
)

const connectorAuthorizationResponseLimit = 4 << 20

type ConnectorAuthorizationClientConfig struct {
	BaseURL          string
	HTTPClient       *http.Client
	AuthorizeRequest func(*http.Request) error
}

// ConnectorAuthorizationClient adapts the Tutti account-scoped Connector
// authorization control plane to the provider-neutral market host contract.
type ConnectorAuthorizationClient struct {
	baseURL          *url.URL
	httpClient       *http.Client
	authorizeRequest func(*http.Request) error
}

func NewConnectorAuthorizationClient(config ConnectorAuthorizationClientConfig) (*ConnectorAuthorizationClient, error) {
	baseURL, err := url.Parse(strings.TrimSpace(config.BaseURL))
	if err != nil || baseURL.Host == "" || (baseURL.Scheme != "https" && (baseURL.Scheme != "http" || !isLoopbackConnectorAuthorizationHost(baseURL.Hostname()))) {
		return nil, errors.New("connector authorization base URL must use https")
	}
	if config.HTTPClient == nil || config.AuthorizeRequest == nil {
		return nil, errors.New("connector authorization HTTP client and account authorizer are required")
	}
	httpClient := *config.HTTPClient
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &ConnectorAuthorizationClient{baseURL: baseURL, httpClient: &httpClient, authorizeRequest: config.AuthorizeRequest}, nil
}

func (client *ConnectorAuthorizationClient) Begin(ctx context.Context, request market.AuthorizationStartRequest) (market.AuthorizationSession, error) {
	defer clear(request.Secret)
	connectorID := strings.TrimSpace(request.Connector.Key)
	connectorVersion := strings.TrimSpace(request.Release.Version)
	method, err := client.resolveMethod(ctx, connectorID, connectorVersion, request.Release.Manifest.AuthorizationKind)
	if err != nil {
		return market.AuthorizationSession{}, err
	}
	var response connectorAuthorizationSessionReply
	err = client.doJSON(ctx, http.MethodPost, "/v1/connectors/"+url.PathEscape(connectorID)+"/authorization-sessions", nil, map[string]any{
		"authorizationMethod": method,
		"clientRequestId":     strings.TrimSpace(request.ClientRequestID),
		"connectorVersion":    connectorVersion,
	}, &response)
	if err != nil {
		return market.AuthorizationSession{}, err
	}
	if strings.TrimSpace(response.Session.SessionID) == "" || strings.TrimSpace(response.Session.ConnectorRevision) != connectorVersion {
		return market.AuthorizationSession{}, errors.New("connector authorization start returned an invalid session")
	}
	actionType := strings.TrimSpace(response.Session.NextAction.Type)
	if actionType == "" && request.Release.Manifest.AuthorizationKind == "api_key" {
		actionType = "submit_secret"
	}
	session := market.AuthorizationSession{
		OperationID: request.OperationID, ConnectorKey: connectorID,
		SessionID: response.Session.SessionID, ActionType: actionType,
	}
	switch actionType {
	case "redirect":
		session.State = market.AuthorizationStatePending
		authorizationURL, parseErr := url.Parse(strings.TrimSpace(response.Session.NextAction.URL))
		if parseErr != nil || authorizationURL.Scheme != "https" || authorizationURL.Host == "" || authorizationURL.User != nil {
			return market.AuthorizationSession{}, errors.New("connector authorization start returned an unsafe redirect URL")
		}
		session.AuthorizationURL = response.Session.NextAction.URL
	case "submit_secret":
		if authorizationSessionSucceeded(response.Session.Status) {
			session.ConnectionID = strings.TrimSpace(response.Session.ResultConnectionID)
			if session.ConnectionID == "" {
				return market.AuthorizationSession{}, errors.New("connector secret authorization completed without a connection id")
			}
			session.State = market.AuthorizationStateConnected
			return session, nil
		}
		if len(request.Secret) == 0 || len(request.Secret) > 16384 {
			return market.AuthorizationSession{}, errors.New("connector authorization requires a valid secret")
		}
		path := "/v1/connector-authorization-sessions/" + url.PathEscape(response.Session.SessionID) + ":complete"
		var completed connectorAuthorizationSessionReply
		if err := client.doJSON(ctx, http.MethodPost, path, nil, map[string]any{"secret": map[string]string{"secret": string(request.Secret)}}, &completed); err != nil {
			return market.AuthorizationSession{}, err
		}
		if completed.Session.SessionID != response.Session.SessionID || strings.TrimSpace(completed.Session.ConnectorRevision) != connectorVersion || !authorizationSessionSucceeded(completed.Session.Status) {
			return market.AuthorizationSession{}, errors.New("connector secret authorization did not complete")
		}
		session.ConnectionID = strings.TrimSpace(completed.Session.ResultConnectionID)
		if session.ConnectionID == "" {
			return market.AuthorizationSession{}, errors.New("connector secret authorization completed without a connection id")
		}
		session.State = market.AuthorizationStateConnected
	default:
		return market.AuthorizationSession{}, errors.New("connector authorization start returned an unsupported action")
	}
	return session, nil
}

func (client *ConnectorAuthorizationClient) Disconnect(ctx context.Context, request market.AuthorizationDisconnectRequest) error {
	connectorID := strings.TrimSpace(request.Connector.Key)
	query := url.Values{"connectorId": {connectorID}}
	var response struct {
		Connections []struct {
			ConnectionID string `json:"connectionId"`
			Status       string `json:"status"`
		} `json:"connections"`
	}
	if err := client.doJSON(ctx, http.MethodGet, "/v1/connector-connections", query, nil, &response); err != nil {
		return err
	}
	for _, connection := range response.Connections {
		if strings.TrimSpace(connection.ConnectionID) == "" || strings.Contains(strings.ToUpper(connection.Status), "REVOKED") {
			continue
		}
		path := "/v1/connector-connections/" + url.PathEscape(connection.ConnectionID) + ":revoke"
		if err := client.doJSON(ctx, http.MethodPost, path, nil, nil, nil); err != nil {
			return err
		}
	}
	return nil
}

func (client *ConnectorAuthorizationClient) Observe(ctx context.Context, request market.AuthorizationObserveRequest) (market.AuthorizationObservation, error) {
	var response struct {
		Session struct {
			Status             string `json:"status"`
			ErrorCode          string `json:"errorCode"`
			ResultConnectionID string `json:"resultConnectionId"`
		} `json:"session"`
	}
	path := "/v1/connector-authorization-sessions/" + url.PathEscape(strings.TrimSpace(request.Session.SessionID))
	if err := client.doJSON(ctx, http.MethodGet, path, nil, nil, &response); err != nil {
		return market.AuthorizationObservation{}, err
	}
	status := strings.ToUpper(strings.TrimSpace(response.Session.Status))
	switch {
	case strings.HasSuffix(status, "_SUCCEEDED") || status == "SUCCEEDED":
		connectionID := strings.TrimSpace(response.Session.ResultConnectionID)
		if connectionID == "" {
			return market.AuthorizationObservation{}, errors.New("connector authorization observation completed without a connection id")
		}
		return market.AuthorizationObservation{State: market.AuthorizationObservationConnected, ConnectionID: connectionID}, nil
	case strings.HasSuffix(status, "_FAILED") || status == "FAILED":
		return market.AuthorizationObservation{State: market.AuthorizationObservationFailed, FailureCode: strings.TrimSpace(response.Session.ErrorCode)}, nil
	case strings.HasSuffix(status, "_CREATED"), strings.HasSuffix(status, "_AWAITING_USER"), strings.HasSuffix(status, "_PROCESSING"),
		status == "CREATED", status == "AWAITING_USER", status == "PROCESSING":
		return market.AuthorizationObservation{State: market.AuthorizationObservationPending}, nil
	default:
		return market.AuthorizationObservation{}, errors.New("connector authorization session returned an invalid status")
	}
}

func (client *ConnectorAuthorizationClient) resolveMethod(ctx context.Context, connectorID, connectorVersion, authorizationKind string) (string, error) {
	var response struct {
		Options []struct {
			Method string `json:"authorizationMethod"`
		} `json:"options"`
	}
	path := "/v1/connectors/" + url.PathEscape(connectorID) + "/authorization-options"
	query := url.Values{"connectorVersion": {strings.TrimSpace(connectorVersion)}}
	if err := client.doJSON(ctx, http.MethodGet, path, query, nil, &response); err != nil {
		return "", err
	}
	kind := strings.TrimSpace(authorizationKind)
	for _, option := range response.Options {
		if strings.TrimSpace(option.Method) == kind {
			return kind, nil
		}
	}
	if len(response.Options) == 1 && strings.TrimSpace(response.Options[0].Method) != "" {
		return strings.TrimSpace(response.Options[0].Method), nil
	}
	return "", errors.New("connector authorization method is unavailable or ambiguous")
}

func (client *ConnectorAuthorizationClient) doJSON(ctx context.Context, method, requestPath string, query url.Values, input, output any) error {
	endpoint, err := url.JoinPath(client.baseURL.String(), requestPath)
	if err != nil {
		return err
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || !strings.EqualFold(parsed.Hostname(), client.baseURL.Hostname()) {
		return errors.New("connector authorization endpoint escaped its configured host")
	}
	if query != nil {
		parsed.RawQuery = query.Encode()
	}
	var body io.Reader
	var encoded []byte
	if input != nil {
		var encodeErr error
		encoded, encodeErr = json.Marshal(input)
		if encodeErr != nil {
			return encodeErr
		}
		defer clear(encoded)
		body = bytes.NewReader(encoded)
	}
	httpRequest, err := http.NewRequestWithContext(ctx, method, parsed.String(), body)
	if err != nil {
		return err
	}
	httpRequest.Header.Set("Accept", "application/json")
	if input != nil {
		httpRequest.Header.Set("Content-Type", "application/json")
	}
	if err := client.authorizeRequest(httpRequest); err != nil {
		return err
	}
	httpResponse, err := client.httpClient.Do(httpRequest)
	if err != nil {
		return err
	}
	defer httpResponse.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(httpResponse.Body, connectorAuthorizationResponseLimit+1))
	if err != nil {
		return err
	}
	if len(payload) > connectorAuthorizationResponseLimit {
		return errors.New("connector authorization response exceeds limit")
	}
	if httpResponse.StatusCode < 200 || httpResponse.StatusCode >= 300 {
		return fmt.Errorf("connector authorization request failed: status %d", httpResponse.StatusCode)
	}
	if output != nil {
		if len(payload) == 0 || json.Unmarshal(payload, output) != nil {
			return errors.New("connector authorization response is invalid")
		}
	}
	return nil
}

type connectorAuthorizationSessionReply struct {
	Session struct {
		SessionID          string `json:"sessionId"`
		ConnectorRevision  string `json:"connectorRevision"`
		Status             string `json:"status"`
		ResultConnectionID string `json:"resultConnectionId"`
		NextAction         struct {
			Type string `json:"type"`
			URL  string `json:"url"`
		} `json:"nextAction"`
	} `json:"session"`
}

func authorizationSessionSucceeded(status string) bool {
	status = strings.ToUpper(strings.TrimSpace(status))
	return status == "SUCCEEDED" || strings.HasSuffix(status, "_SUCCEEDED")
}

func isLoopbackConnectorAuthorizationHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

var _ market.AuthorizationProvider = (*ConnectorAuthorizationClient)(nil)
var _ market.AuthorizationObserver = (*ConnectorAuthorizationClient)(nil)
