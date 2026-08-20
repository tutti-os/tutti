package connectorcontrolplane

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

const connectorAuthorizationResponseLimit = 4 << 20

type AuthorizationClientConfig struct {
	BaseURL                    string
	APIPrefix                  string
	HTTPClient                 *http.Client
	AuthorizeAccountRequest    func(*http.Request, string) error
	NotifyAuthorizationChanged func()
}

// AuthorizationClient adapts the Tutti account-scoped Connector
// authorization control plane to the provider-neutral market host contract.
type AuthorizationClient struct {
	baseURL                    *url.URL
	apiPrefix                  string
	httpClient                 *http.Client
	authorizeAccountRequest    func(*http.Request, string) error
	notifyAuthorizationChanged func()
}

func NewAuthorizationClient(config AuthorizationClientConfig) (*AuthorizationClient, error) {
	baseURL, err := url.Parse(strings.TrimSpace(config.BaseURL))
	if err != nil || baseURL.Host == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" ||
		(baseURL.Scheme != "https" && (baseURL.Scheme != "http" || !isLoopbackConnectorAuthorizationHost(baseURL.Hostname()))) {
		return nil, errors.New("connector authorization base URL must use https")
	}
	if config.HTTPClient == nil || config.AuthorizeAccountRequest == nil {
		return nil, errors.New("connector authorization HTTP client and account authorizer are required")
	}
	httpClient := *config.HTTPClient
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	apiPrefix := strings.TrimSpace(config.APIPrefix)
	if apiPrefix == "" || strings.ContainsAny(apiPrefix, "?#") {
		return nil, errors.New("connector authorization API prefix is required")
	}
	apiPrefix = "/" + strings.Trim(apiPrefix, "/")
	return &AuthorizationClient{
		baseURL: baseURL, apiPrefix: apiPrefix, httpClient: &httpClient,
		authorizeAccountRequest:    config.AuthorizeAccountRequest,
		notifyAuthorizationChanged: config.NotifyAuthorizationChanged,
	}, nil
}

func (client *AuthorizationClient) AuthorizationSnapshot(ctx context.Context, accountID string) (market.AuthorizationSnapshot, error) {
	accountID = strings.TrimSpace(accountID)
	if accountID == "" || client.authorizeAccountRequest == nil {
		return market.AuthorizationSnapshot{}, errors.New("connector authorization snapshot requires an account-bound authorizer")
	}
	var response struct {
		Revision   jsonUint64 `json:"revision"`
		Connectors []struct {
			ConnectorID       string     `json:"connectorId"`
			ConnectorVersion  string     `json:"connectorVersion"`
			State             string     `json:"state"`
			ConnectionID      string     `json:"connectionId"`
			ConnectionVersion jsonUint64 `json:"connectionVersion"`
		} `json:"connectors"`
	}
	if err := client.doJSONWithAuthorizer(ctx, http.MethodGet, "/connector-authorizations/snapshot", nil, nil, &response, func(request *http.Request) error {
		return client.authorizeAccountRequest(request, accountID)
	}); err != nil {
		return market.AuthorizationSnapshot{}, err
	}
	snapshot := market.AuthorizationSnapshot{Revision: uint64(response.Revision), Connectors: make([]market.AuthorizationProjection, 0, len(response.Connectors))}
	for _, item := range response.Connectors {
		projection := market.AuthorizationProjection{
			AccountID: accountID, ConnectorKey: strings.TrimSpace(item.ConnectorID), ConnectorVersion: strings.TrimSpace(item.ConnectorVersion),
			ConnectionID: strings.TrimSpace(item.ConnectionID), ConnectionVersion: uint64(item.ConnectionVersion), ServerRevision: uint64(response.Revision), ServerSynchronized: true,
		}
		switch strings.ToLower(strings.TrimSpace(item.State)) {
		case "connected":
			projection.State = market.AuthorizationStateConnected
		case "reauth_required":
			projection.State = market.AuthorizationStateExpired
		case "disconnected":
			projection.State = market.AuthorizationStateDisconnected
		default:
			return market.AuthorizationSnapshot{}, errors.New("connector authorization snapshot returned an invalid state")
		}
		if projection.ConnectorKey == "" || projection.State == market.AuthorizationStateConnected && projection.ConnectionID == "" {
			return market.AuthorizationSnapshot{}, errors.New("connector authorization snapshot returned an invalid connector")
		}
		snapshot.Connectors = append(snapshot.Connectors, projection)
	}
	return snapshot, nil
}

func (client *AuthorizationClient) Begin(ctx context.Context, request market.AuthorizationStartRequest) (market.AuthorizationSession, error) {
	defer clear(request.Secret)
	connectorID := strings.TrimSpace(request.Connector.Key)
	connectorVersion := strings.TrimSpace(request.Release.Version)
	body := map[string]any{
		"clientRequestId":  strings.TrimSpace(request.ClientRequestID),
		"connectorVersion": connectorVersion,
	}
	switch request.ReplacementPolicy {
	case "":
	case market.AuthorizationReplacementPolicyReplaceActive:
		body["replacementPolicy"] = "CONNECTOR_AUTHORIZATION_REPLACEMENT_POLICY_REPLACE_ACTIVE"
	default:
		return market.AuthorizationSession{}, errors.New("connector authorization replacement policy is invalid")
	}
	var response connectorAuthorizationSessionReply
	err := client.doJSONForAccount(ctx, request.Scope.AccountID, http.MethodPost, "/connectors/"+url.PathEscape(connectorID)+"/authorization-sessions", nil, body, &response)
	if err != nil {
		return market.AuthorizationSession{}, err
	}
	client.notifyChanged()
	if strings.TrimSpace(response.Session.SessionID) == "" || strings.TrimSpace(response.Session.ConnectorRevision) != connectorVersion {
		return market.AuthorizationSession{}, errors.New("connector authorization start returned an invalid session")
	}
	if authorizationSessionSucceeded(response.Session.Status) {
		connectionID := strings.TrimSpace(response.Session.ResultConnectionID)
		if connectionID == "" {
			return market.AuthorizationSession{}, errors.New("connector authorization start completed without a connection id")
		}
		return market.AuthorizationSession{
			OperationID: request.OperationID, ConnectorKey: connectorID,
			SessionID: response.Session.SessionID, ConnectionID: connectionID,
			State: market.AuthorizationStateConnected,
		}, nil
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
		path := "/connector-authorization-sessions/" + url.PathEscape(response.Session.SessionID) + "/complete"
		var completed connectorAuthorizationSessionReply
		if err := client.doJSONForAccount(ctx, request.Scope.AccountID, http.MethodPost, path, nil, map[string]any{"secret": map[string]string{"secret": string(request.Secret)}}, &completed); err != nil {
			return market.AuthorizationSession{}, err
		}
		client.notifyChanged()
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

func (client *AuthorizationClient) Cancel(ctx context.Context, request market.AuthorizationCancelRequest) error {
	sessionID := strings.TrimSpace(request.Session.SessionID)
	if sessionID == "" {
		return errors.New("connector authorization cancellation requires a session id")
	}
	var response connectorAuthorizationSessionReply
	if err := client.doJSONForAccount(ctx, request.Scope.AccountID, http.MethodDelete,
		"/connector-authorization-sessions/"+url.PathEscape(sessionID), nil, nil, &response); err != nil {
		return err
	}
	if strings.TrimSpace(response.Session.SessionID) != sessionID ||
		(!authorizationSessionCanceled(response.Session.Status) && !authorizationSessionFailed(response.Session.Status)) {
		return errors.New("connector authorization cancellation returned a non-terminal session")
	}
	client.notifyChanged()
	return nil
}

func (client *AuthorizationClient) Disconnect(ctx context.Context, request market.AuthorizationDisconnectRequest) error {
	connectorID := strings.TrimSpace(request.Connector.Key)
	if err := client.doJSONForAccount(ctx, request.Scope.AccountID, http.MethodDelete,
		"/connectors/"+url.PathEscape(connectorID)+"/authorization", nil, nil, nil); err != nil {
		return err
	}
	client.notifyChanged()
	return nil
}

func (client *AuthorizationClient) notifyChanged() {
	if client != nil && client.notifyAuthorizationChanged != nil {
		client.notifyAuthorizationChanged()
	}
}

func (client *AuthorizationClient) Observe(ctx context.Context, request market.AuthorizationObserveRequest) (market.AuthorizationObservation, error) {
	var response struct {
		Session struct {
			Status             string `json:"status"`
			ErrorCode          string `json:"errorCode"`
			ResultConnectionID string `json:"resultConnectionId"`
		} `json:"session"`
	}
	path := "/connector-authorization-sessions/" + url.PathEscape(strings.TrimSpace(request.Session.SessionID))
	if err := client.doJSONForAccount(ctx, request.Scope.AccountID, http.MethodGet, path, nil, nil, &response); err != nil {
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
	case strings.HasSuffix(status, "_CANCELED") || status == "CANCELED":
		return market.AuthorizationObservation{State: market.AuthorizationObservationFailed, FailureCode: "authorization_canceled"}, nil
	case strings.HasSuffix(status, "_CREATED"), strings.HasSuffix(status, "_AWAITING_USER"), strings.HasSuffix(status, "_PROCESSING"),
		status == "CREATED", status == "AWAITING_USER", status == "PROCESSING":
		return market.AuthorizationObservation{State: market.AuthorizationObservationPending}, nil
	default:
		return market.AuthorizationObservation{}, errors.New("connector authorization session returned an invalid status")
	}
}

func (client *AuthorizationClient) doJSONForAccount(ctx context.Context, accountID, method, requestPath string, query url.Values, input, output any) error {
	accountID = strings.TrimSpace(accountID)
	if accountID == "" {
		return errors.New("connector authorization request requires an account scope")
	}
	return client.doJSONWithAuthorizer(ctx, method, requestPath, query, input, output, func(request *http.Request) error {
		return client.authorizeAccountRequest(request, accountID)
	})
}

type jsonUint64 uint64

func (value *jsonUint64) UnmarshalJSON(raw []byte) error {
	text := strings.Trim(strings.TrimSpace(string(raw)), `"`)
	parsed, err := strconv.ParseUint(text, 10, 64)
	if err != nil {
		return errors.New("invalid uint64 JSON value")
	}
	*value = jsonUint64(parsed)
	return nil
}

func (client *AuthorizationClient) doJSONWithAuthorizer(ctx context.Context, method, requestPath string, query url.Values, input, output any, authorize func(*http.Request) error) error {
	endpoint, err := url.JoinPath(client.baseURL.String(), client.apiPrefix, requestPath)
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
	if authorize == nil {
		return errors.New("connector authorization request authorizer is unavailable")
	}
	if err := authorize(httpRequest); err != nil {
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

func authorizationSessionFailed(status string) bool {
	status = strings.ToUpper(strings.TrimSpace(status))
	return status == "FAILED" || strings.HasSuffix(status, "_FAILED")
}

func authorizationSessionCanceled(status string) bool {
	status = strings.ToUpper(strings.TrimSpace(status))
	return status == "CANCELED" || strings.HasSuffix(status, "_CANCELED")
}

func isLoopbackConnectorAuthorizationHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

var _ market.AuthorizationProvider = (*AuthorizationClient)(nil)
var _ market.AuthorizationAttemptCanceler = (*AuthorizationClient)(nil)
var _ market.AuthorizationObserver = (*AuthorizationClient)(nil)
var _ market.AuthorizationSnapshotSource = (*AuthorizationClient)(nil)
