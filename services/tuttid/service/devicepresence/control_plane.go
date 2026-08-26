package devicepresence

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
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/httpx"
)

const (
	DefaultControlPlaneBaseURL = "https://tutti.sh/api/desktop/v1"
	maximumResponseBytes       = 1 << 20
)

type ControlPlane interface {
	RegisterCurrentDevice(context.Context, string, DeviceMetadata) error
	OpenSession(context.Context, string, string, string) (Lease, error)
	Heartbeat(context.Context, string, string) error
	CloseSession(context.Context, string, string) error
}

type DeviceMetadata struct {
	DeviceID      string
	ReportedName  string
	Platform      string
	Arch          string
	ClientVersion string
}

type Lease struct {
	PresenceLeaseID          string
	HeartbeatIntervalSeconds int
}

type HTTPControlPlane struct {
	BaseURL    string
	Headers    http.Header
	HTTPClient *http.Client
}

type ControlPlaneError struct {
	StatusCode int
	Code       string
	Reason     string
}

func (e *ControlPlaneError) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("device presence control-plane request failed (%d): %s", e.StatusCode, firstNonEmpty(e.Reason, e.Code, "request rejected"))
}

func (e *ControlPlaneError) IsStatus(statusCode int) bool {
	return e != nil && e.StatusCode == statusCode
}

func (client *HTTPControlPlane) RegisterCurrentDevice(ctx context.Context, cookie string, metadata DeviceMetadata) error {
	request := struct {
		DeviceID      string `json:"deviceId"`
		ReportedName  string `json:"reportedName"`
		Platform      string `json:"platform"`
		Arch          string `json:"arch"`
		ClientVersion string `json:"clientVersion"`
	}{
		DeviceID: metadata.DeviceID, ReportedName: metadata.ReportedName, Platform: metadata.Platform,
		Arch: metadata.Arch, ClientVersion: metadata.ClientVersion,
	}
	var response struct {
		Device struct {
			UserDeviceID string `json:"userDeviceId"`
			DeviceID     string `json:"deviceId"`
		} `json:"device"`
	}
	if err := client.doJSON(ctx, http.MethodPut, "/devices/current", cookie, request, &response); err != nil {
		return err
	}
	if strings.TrimSpace(response.Device.UserDeviceID) == "" || strings.TrimSpace(response.Device.DeviceID) != strings.TrimSpace(metadata.DeviceID) {
		return errors.New("device presence registration response is incomplete")
	}
	return nil
}

func (client *HTTPControlPlane) OpenSession(ctx context.Context, cookie, deviceID, presenceSessionID string) (Lease, error) {
	request := struct {
		DeviceID          string `json:"deviceId"`
		PresenceSessionID string `json:"presenceSessionId"`
	}{DeviceID: strings.TrimSpace(deviceID), PresenceSessionID: strings.TrimSpace(presenceSessionID)}
	var response struct {
		PresenceLeaseID          string `json:"presenceLeaseId"`
		UserDeviceID             string `json:"userDeviceId"`
		HeartbeatIntervalSeconds int    `json:"heartbeatIntervalSeconds"`
	}
	if err := client.doJSON(ctx, http.MethodPost, "/device-presence/sessions", cookie, request, &response); err != nil {
		return Lease{}, err
	}
	lease := Lease{PresenceLeaseID: strings.TrimSpace(response.PresenceLeaseID), HeartbeatIntervalSeconds: response.HeartbeatIntervalSeconds}
	if lease.PresenceLeaseID == "" || strings.TrimSpace(response.UserDeviceID) == "" || lease.HeartbeatIntervalSeconds <= 0 {
		return Lease{}, errors.New("device presence open response is incomplete")
	}
	return lease, nil
}

func (client *HTTPControlPlane) Heartbeat(ctx context.Context, cookie, leaseID string) error {
	var response struct {
		State string `json:"state"`
	}
	path := "/device-presence/sessions/" + url.PathEscape(strings.TrimSpace(leaseID)) + "/heartbeat"
	if err := client.doJSON(ctx, http.MethodPost, path, cookie, nil, &response); err != nil {
		return err
	}
	if enumSuffix(response.State) != "ACTIVE" {
		return errors.New("device presence heartbeat did not activate the lease")
	}
	return nil
}

func (client *HTTPControlPlane) CloseSession(ctx context.Context, cookie, leaseID string) error {
	return client.doJSON(ctx, http.MethodDelete, "/device-presence/sessions/"+url.PathEscape(strings.TrimSpace(leaseID)), cookie, nil, nil)
}

func (client *HTTPControlPlane) doJSON(ctx context.Context, method, path, cookie string, requestBody, responseBody any) error {
	baseURL := strings.TrimRight(strings.TrimSpace(client.BaseURL), "/")
	if baseURL == "" {
		baseURL = DefaultControlPlaneBaseURL
	}
	var body io.Reader
	if requestBody != nil {
		raw, err := json.Marshal(requestBody)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	}
	request, err := http.NewRequestWithContext(ctx, method, baseURL+path, body)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	if requestBody != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	for name, values := range client.Headers {
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	request.Header.Set("Cookie", strings.TrimSpace(cookie))
	httpClient := client.HTTPClient
	if httpClient == nil {
		httpClient = httpx.NewClient(5 * time.Second)
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("send device presence request: %w", err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	if err != nil {
		return err
	}
	if len(raw) > maximumResponseBytes {
		return errors.New("device presence response is too large")
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		var body struct {
			Error struct {
				Code   string `json:"code"`
				Reason string `json:"reason"`
			} `json:"error"`
		}
		_ = json.Unmarshal(raw, &body)
		return &ControlPlaneError{StatusCode: response.StatusCode, Code: body.Error.Code, Reason: body.Error.Reason}
	}
	if responseBody != nil && len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, responseBody); err != nil {
			return fmt.Errorf("decode device presence response: %w", err)
		}
	}
	return nil
}

func enumSuffix(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	if index := strings.LastIndexByte(value, '_'); index >= 0 {
		return value[index+1:]
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
