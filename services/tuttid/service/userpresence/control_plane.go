package userpresence

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/httpx"
	authbridge "github.com/tutti-os/tutti/packages/auth/bridge-go"
)

const (
	DefaultControlPlaneBaseURL = "https://tutti.sh/api/desktop/v1"
	maximumSnapshotResponse    = 1 << 20
)

type HTTPControlPlane struct {
	BaseURL    string
	Headers    http.Header
	HTTPClient *http.Client
	Account    AccountSessionSource
}

type AccountSessionSource interface {
	ReadSession() (*authbridge.Session, error)
}

func (client *HTTPControlPlane) BatchGetUserPresence(ctx context.Context, userIDs []string) (PresenceSnapshot, error) {
	if client == nil || client.Account == nil {
		return PresenceSnapshot{}, errors.New("user presence control plane is not configured")
	}
	session, err := client.Account.ReadSession()
	if err != nil || strings.TrimSpace(session.Cookie) == "" {
		return PresenceSnapshot{}, errors.New("user presence account session is unavailable")
	}
	requestBody, err := json.Marshal(struct {
		UserIDs []string `json:"userIds"`
	}{UserIDs: sortedUserIDs(userIDs)})
	if err != nil {
		return PresenceSnapshot{}, fmt.Errorf("encode user presence snapshot request: %w", err)
	}
	baseURL := strings.TrimRight(strings.TrimSpace(client.BaseURL), "/")
	if baseURL == "" {
		baseURL = DefaultControlPlaneBaseURL
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/device-presence/users/batch-get", bytes.NewReader(requestBody))
	if err != nil {
		return PresenceSnapshot{}, fmt.Errorf("create user presence snapshot request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	for name, values := range client.Headers {
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	request.Header.Set("Cookie", strings.TrimSpace(session.Cookie))
	httpClient := client.HTTPClient
	if httpClient == nil {
		httpClient = httpx.NewClient(5 * time.Second)
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return PresenceSnapshot{}, fmt.Errorf("send user presence snapshot request: %w", err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, maximumSnapshotResponse+1))
	if err != nil {
		return PresenceSnapshot{}, fmt.Errorf("read user presence snapshot response: %w", err)
	}
	if len(raw) > maximumSnapshotResponse {
		return PresenceSnapshot{}, errors.New("user presence snapshot response is too large")
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return PresenceSnapshot{}, fmt.Errorf("user presence snapshot request failed with status %d", response.StatusCode)
	}
	var body struct {
		Users []struct {
			UserID           string `json:"userId"`
			Status           string `json:"status"`
			ObservedAt       string `json:"observedAt"`
			PresenceRevision string `json:"presenceRevision"`
		} `json:"users"`
		PresenceAvailability string `json:"presenceAvailability"`
		AuthorityGeneration  string `json:"authorityGeneration"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return PresenceSnapshot{}, errors.New("decode user presence snapshot response")
	}
	snapshot := PresenceSnapshot{
		AuthorityGeneration: strings.TrimSpace(body.AuthorityGeneration),
		Available:           enumSuffix(body.PresenceAvailability) == "AVAILABLE",
		Users:               make([]SnapshotUser, 0, len(body.Users)),
	}
	for _, user := range body.Users {
		status := Status(enumSuffix(user.Status))
		if !validStatus(status) {
			status = StatusOffline
		}
		observedAt, _ := time.Parse(time.RFC3339Nano, strings.TrimSpace(user.ObservedAt))
		snapshot.Users = append(snapshot.Users, SnapshotUser{
			UserID: strings.TrimSpace(user.UserID), Status: status,
			PresenceRevision: strings.TrimSpace(user.PresenceRevision), ObservedAt: observedAt,
		})
	}
	return snapshot, nil
}

func enumSuffix(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	if index := strings.LastIndexByte(value, '_'); index >= 0 {
		return value[index+1:]
	}
	return value
}
