package mobileremote

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	mobileremotebiz "github.com/tutti-os/tutti/services/tuttid/biz/mobileremote"
)

const (
	DefaultControlPlaneBaseURL = "https://tutti.sh/api/desktop/v1"
	maxControlPlaneResponse    = 1 << 20
)

type ControlPlane interface {
	RegisterDevice(context.Context, string, RegisterDeviceInput) (RegisteredDevice, error)
	CreateChallenge(context.Context, string, string) (CreateChallengeResult, error)
	GetChallenge(context.Context, string, string) (mobileremotebiz.PairingChallenge, error)
	ConfirmChallenge(context.Context, string, string, string, []byte) (ConfirmChallengeResult, error)
	ListPairings(context.Context, string) ([]mobileremotebiz.DevicePairing, error)
	RevokePairing(context.Context, string, string) (mobileremotebiz.DevicePairing, error)
	ListDeviceLinkAttempts(context.Context, string, string, string, []byte) ([]DeviceLinkAttempt, error)
	UpdateDeviceLinkParticipant(context.Context, string, string, string, string, DeviceLinkParticipantInput) (DeviceLinkAttempt, error)
}

type RegisterDeviceInput struct {
	DeviceID      string
	ReportedName  string
	Platform      string
	Arch          string
	ClientVersion string
	Algorithm     string
	PublicKey     []byte
	Proof         []byte
}

type RegisteredDevice struct {
	UserDeviceID string
	DeviceID     string
}

type DeviceLinkICEParams struct {
	Ufrag      string   `json:"ufrag"`
	Pwd        string   `json:"pwd"`
	Candidates []string `json:"candidates"`
}

type DeviceLinkAttempt struct {
	AttemptID             string               `json:"attemptId"`
	PairingID             string               `json:"scopeId"`
	CallerDeviceID        string               `json:"callerDeviceId"`
	CallerFingerprint     string               `json:"callerFingerprint"`
	CallerICE             *DeviceLinkICEParams `json:"callerIce"`
	CallerProtocolVersion int                  `json:"callerProtocolVersion"`
	OwnerDeviceID         string               `json:"ownerDeviceId"`
	OwnerFingerprint      string               `json:"ownerFingerprint"`
	OwnerICE              *DeviceLinkICEParams `json:"ownerIce"`
	OwnerProtocolVersion  int                  `json:"ownerProtocolVersion"`
	State                 string               `json:"state"`
	STUNEndpoints         []string             `json:"stunEndpoints"`
	ExpiresAt             string               `json:"expiresAt"`
}

type DeviceLinkParticipantInput struct {
	Fingerprint       string
	ProtocolVersion   int
	ICE               DeviceLinkICEParams
	IdentitySignature []byte
}

type CreateChallengeResult struct {
	Challenge mobileremotebiz.PairingChallenge
	Secret    string
}

type ConfirmChallengeResult struct {
	Pairing   mobileremotebiz.DevicePairing
	Challenge mobileremotebiz.PairingChallenge
}

type HTTPControlPlane struct {
	BaseURL    string
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
	detail := strings.TrimSpace(e.Reason)
	if detail == "" {
		detail = strings.TrimSpace(e.Code)
	}
	if detail == "" {
		detail = "request rejected"
	}
	return fmt.Sprintf("mobile remote control-plane request failed (%d): %s", e.StatusCode, detail)
}

type userDeviceRegistrationWire struct {
	DeviceID       string                   `json:"deviceId"`
	ReportedName   string                   `json:"reportedName"`
	Platform       string                   `json:"platform"`
	Arch           string                   `json:"arch"`
	ClientVersion  string                   `json:"clientVersion"`
	PublicIdentity devicePublicIdentityWire `json:"publicIdentity"`
}

type devicePublicIdentityWire struct {
	Algorithm string `json:"algorithm"`
	PublicKey []byte `json:"publicKey"`
	Proof     []byte `json:"proof"`
}

type registeredDeviceWire struct {
	UserDeviceID string `json:"userDeviceId"`
	DeviceID     string `json:"deviceId"`
}

type pairingChallengeWire struct {
	ChallengeID            string `json:"challengeId"`
	TargetUserDeviceID     string `json:"targetUserDeviceId"`
	ControllerUserDeviceID string `json:"controllerUserDeviceId"`
	State                  string `json:"state"`
	PairingID              string `json:"pairingId"`
	Revision               uint64 `json:"revision,string"`
	ExpiresAt              string `json:"expiresAt"`
}

type pairingWire struct {
	PairingID              string  `json:"pairingId"`
	ControllerUserDeviceID string  `json:"controllerUserDeviceId"`
	TargetUserDeviceID     string  `json:"targetUserDeviceId"`
	State                  string  `json:"state"`
	Revision               uint64  `json:"revision,string"`
	ConfirmedAt            string  `json:"confirmedAt"`
	RevokedAt              *string `json:"revokedAt"`
}

func (c *HTTPControlPlane) RegisterDevice(ctx context.Context, cookie string, input RegisterDeviceInput) (RegisteredDevice, error) {
	request := userDeviceRegistrationWire{
		DeviceID: strings.TrimSpace(input.DeviceID), ReportedName: strings.TrimSpace(input.ReportedName),
		Platform: strings.TrimSpace(input.Platform), Arch: strings.TrimSpace(input.Arch),
		ClientVersion: strings.TrimSpace(input.ClientVersion),
		PublicIdentity: devicePublicIdentityWire{
			Algorithm: strings.TrimSpace(input.Algorithm),
			PublicKey: append([]byte(nil), input.PublicKey...),
			Proof:     append([]byte(nil), input.Proof...),
		},
	}
	var response struct {
		Device registeredDeviceWire `json:"device"`
	}
	if err := c.doJSON(ctx, http.MethodPut, "/devices/current", cookie, request, &response); err != nil {
		return RegisteredDevice{}, err
	}
	device := RegisteredDevice{
		UserDeviceID: strings.TrimSpace(response.Device.UserDeviceID),
		DeviceID:     strings.TrimSpace(response.Device.DeviceID),
	}
	if device.UserDeviceID == "" || device.DeviceID != strings.TrimSpace(input.DeviceID) {
		return RegisteredDevice{}, errors.New("control-plane registered device is incomplete")
	}
	return device, nil
}

func (c *HTTPControlPlane) CreateChallenge(ctx context.Context, cookie, targetDeviceID string) (CreateChallengeResult, error) {
	var response struct {
		Challenge pairingChallengeWire `json:"challenge"`
		Secret    string               `json:"secret"`
	}
	if err := c.doJSON(ctx, http.MethodPost, "/device-pairing-challenges", cookie,
		map[string]string{"targetDeviceId": strings.TrimSpace(targetDeviceID)}, &response); err != nil {
		return CreateChallengeResult{}, err
	}
	challenge, err := pairingChallengeFromWire(response.Challenge)
	if err != nil {
		return CreateChallengeResult{}, err
	}
	if strings.TrimSpace(response.Secret) == "" {
		return CreateChallengeResult{}, fmt.Errorf("control-plane challenge secret is missing")
	}
	return CreateChallengeResult{Challenge: challenge, Secret: strings.TrimSpace(response.Secret)}, nil
}

func (c *HTTPControlPlane) GetChallenge(ctx context.Context, cookie, challengeID string) (mobileremotebiz.PairingChallenge, error) {
	var response struct {
		Challenge pairingChallengeWire `json:"challenge"`
	}
	path := "/device-pairing-challenges/" + url.PathEscape(strings.TrimSpace(challengeID))
	if err := c.doJSON(ctx, http.MethodGet, path, cookie, nil, &response); err != nil {
		return mobileremotebiz.PairingChallenge{}, err
	}
	return pairingChallengeFromWire(response.Challenge)
}

func (c *HTTPControlPlane) ConfirmChallenge(ctx context.Context, cookie, challengeID, secret string, signature []byte) (ConfirmChallengeResult, error) {
	var response struct {
		Pairing   pairingWire          `json:"pairing"`
		Challenge pairingChallengeWire `json:"challenge"`
	}
	path := "/device-pairing-challenges/" + url.PathEscape(strings.TrimSpace(challengeID)) + "/confirm"
	request := map[string]any{
		"secret":    strings.TrimSpace(secret),
		"signature": append([]byte(nil), signature...),
	}
	if err := c.doJSON(ctx, http.MethodPost, path, cookie, request, &response); err != nil {
		return ConfirmChallengeResult{}, err
	}
	pairing, err := pairingFromWire(response.Pairing)
	if err != nil {
		return ConfirmChallengeResult{}, err
	}
	challenge, err := pairingChallengeFromWire(response.Challenge)
	if err != nil {
		return ConfirmChallengeResult{}, err
	}
	return ConfirmChallengeResult{Pairing: pairing, Challenge: challenge}, nil
}

func (c *HTTPControlPlane) ListPairings(ctx context.Context, cookie string) ([]mobileremotebiz.DevicePairing, error) {
	var response struct {
		Pairings []pairingWire `json:"pairings"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/device-pairings", cookie, nil, &response); err != nil {
		return nil, err
	}
	pairings := make([]mobileremotebiz.DevicePairing, 0, len(response.Pairings))
	for _, wire := range response.Pairings {
		pairing, err := pairingFromWire(wire)
		if err != nil {
			return nil, err
		}
		pairings = append(pairings, pairing)
	}
	return pairings, nil
}

func (c *HTTPControlPlane) RevokePairing(ctx context.Context, cookie, pairingID string) (mobileremotebiz.DevicePairing, error) {
	var response struct {
		Pairing pairingWire `json:"pairing"`
	}
	path := "/device-pairings/" + url.PathEscape(strings.TrimSpace(pairingID))
	if err := c.doJSON(ctx, http.MethodDelete, path, cookie, nil, &response); err != nil {
		return mobileremotebiz.DevicePairing{}, err
	}
	return pairingFromWire(response.Pairing)
}

func (c *HTTPControlPlane) ListDeviceLinkAttempts(
	ctx context.Context,
	cookie string,
	pairingID string,
	deviceID string,
	identitySignature []byte,
) ([]DeviceLinkAttempt, error) {
	query := url.Values{}
	query.Set("deviceId", strings.TrimSpace(deviceID))
	query.Set("identitySignature", base64.RawURLEncoding.EncodeToString(identitySignature))
	path := "/device-pairings/" + url.PathEscape(strings.TrimSpace(pairingID)) +
		"/device-link-attempts?" + query.Encode()
	var response struct {
		Attempts []DeviceLinkAttempt `json:"attempts"`
	}
	if err := c.doJSON(ctx, http.MethodGet, path, cookie, nil, &response); err != nil {
		return nil, err
	}
	attempts := make([]DeviceLinkAttempt, 0, len(response.Attempts))
	for _, attempt := range response.Attempts {
		normalized, err := normalizeDeviceLinkAttempt(attempt)
		if err != nil {
			return nil, err
		}
		attempts = append(attempts, normalized)
	}
	return attempts, nil
}

func (c *HTTPControlPlane) UpdateDeviceLinkParticipant(
	ctx context.Context,
	cookie string,
	pairingID string,
	attemptID string,
	deviceID string,
	input DeviceLinkParticipantInput,
) (DeviceLinkAttempt, error) {
	query := url.Values{}
	query.Set("deviceId", strings.TrimSpace(deviceID))
	path := "/device-pairings/" + url.PathEscape(strings.TrimSpace(pairingID)) +
		"/device-link-attempts/" + url.PathEscape(strings.TrimSpace(attemptID)) +
		"/participant?" + query.Encode()
	request := map[string]any{
		"ephemeralFingerprint": strings.TrimSpace(input.Fingerprint),
		"candidates":           []any{},
		"protocolVersion":      input.ProtocolVersion,
		"ice":                  input.ICE,
		"identitySignature":    append([]byte(nil), input.IdentitySignature...),
	}
	var response struct {
		Attempt DeviceLinkAttempt `json:"attempt"`
	}
	if err := c.doJSON(ctx, http.MethodPost, path, cookie, request, &response); err != nil {
		return DeviceLinkAttempt{}, err
	}
	return normalizeDeviceLinkAttempt(response.Attempt)
}

func (c *HTTPControlPlane) doJSON(ctx context.Context, method, path, cookie string, requestBody, responseBody any) error {
	baseURL := strings.TrimRight(strings.TrimSpace(c.BaseURL), "/")
	if baseURL == "" {
		baseURL = DefaultControlPlaneBaseURL
	}
	var body io.Reader
	if requestBody != nil {
		raw, err := json.Marshal(requestBody)
		if err != nil {
			return fmt.Errorf("encode mobile remote control-plane request: %w", err)
		}
		body = bytes.NewReader(raw)
	}
	request, err := http.NewRequestWithContext(ctx, method, baseURL+path, body)
	if err != nil {
		return fmt.Errorf("create mobile remote control-plane request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	if requestBody != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set("Cookie", strings.TrimSpace(cookie))
	client := c.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("send mobile remote control-plane request: %w", err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxControlPlaneResponse+1))
	if err != nil {
		return fmt.Errorf("read mobile remote control-plane response: %w", err)
	}
	if len(raw) > maxControlPlaneResponse {
		return fmt.Errorf("mobile remote control-plane response exceeds %d bytes", maxControlPlaneResponse)
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return controlPlaneError(response.StatusCode, raw)
	}
	if responseBody == nil || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, responseBody); err != nil {
		return fmt.Errorf("decode mobile remote control-plane response: %w", err)
	}
	return nil
}

func controlPlaneError(statusCode int, raw []byte) error {
	var response struct {
		Error struct {
			Code   string `json:"code"`
			Reason string `json:"reason"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &response)
	return &ControlPlaneError{
		StatusCode: statusCode,
		Code:       strings.TrimSpace(response.Error.Code),
		Reason:     strings.TrimSpace(response.Error.Reason),
	}
}

func pairingChallengeFromWire(wire pairingChallengeWire) (mobileremotebiz.PairingChallenge, error) {
	expiresAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(wire.ExpiresAt))
	if err != nil {
		return mobileremotebiz.PairingChallenge{}, fmt.Errorf("parse pairing challenge expiry: %w", err)
	}
	challenge := mobileremotebiz.PairingChallenge{
		ChallengeID: strings.TrimSpace(wire.ChallengeID), TargetUserDeviceID: strings.TrimSpace(wire.TargetUserDeviceID),
		ControllerUserDeviceID: strings.TrimSpace(wire.ControllerUserDeviceID), State: strings.TrimSpace(wire.State),
		PairingID: strings.TrimSpace(wire.PairingID), Revision: wire.Revision, ExpiresAt: expiresAt.UTC(),
	}
	if challenge.ChallengeID == "" || challenge.TargetUserDeviceID == "" || challenge.State == "" {
		return mobileremotebiz.PairingChallenge{}, fmt.Errorf("control-plane pairing challenge is incomplete")
	}
	return challenge, nil
}

func pairingFromWire(wire pairingWire) (mobileremotebiz.DevicePairing, error) {
	confirmedAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(wire.ConfirmedAt))
	if err != nil {
		return mobileremotebiz.DevicePairing{}, fmt.Errorf("parse device pairing confirmation time: %w", err)
	}
	var revokedAt *time.Time
	if wire.RevokedAt != nil && strings.TrimSpace(*wire.RevokedAt) != "" {
		value, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(*wire.RevokedAt))
		if err != nil {
			return mobileremotebiz.DevicePairing{}, fmt.Errorf("parse device pairing revocation time: %w", err)
		}
		value = value.UTC()
		revokedAt = &value
	}
	pairing := mobileremotebiz.DevicePairing{
		PairingID: strings.TrimSpace(wire.PairingID), ControllerUserDeviceID: strings.TrimSpace(wire.ControllerUserDeviceID),
		TargetUserDeviceID: strings.TrimSpace(wire.TargetUserDeviceID), State: strings.TrimSpace(wire.State),
		Revision: wire.Revision, ConfirmedAt: confirmedAt.UTC(), RevokedAt: revokedAt,
	}
	if pairing.PairingID == "" || pairing.ControllerUserDeviceID == "" || pairing.TargetUserDeviceID == "" || pairing.State == "" {
		return mobileremotebiz.DevicePairing{}, fmt.Errorf("control-plane device pairing is incomplete")
	}
	return pairing, nil
}

func normalizeDeviceLinkAttempt(attempt DeviceLinkAttempt) (DeviceLinkAttempt, error) {
	attempt.AttemptID = strings.TrimSpace(attempt.AttemptID)
	attempt.PairingID = strings.TrimSpace(attempt.PairingID)
	attempt.CallerDeviceID = strings.TrimSpace(attempt.CallerDeviceID)
	attempt.CallerFingerprint = strings.TrimSpace(attempt.CallerFingerprint)
	attempt.OwnerDeviceID = strings.TrimSpace(attempt.OwnerDeviceID)
	attempt.OwnerFingerprint = strings.TrimSpace(attempt.OwnerFingerprint)
	attempt.State = strings.TrimSpace(attempt.State)
	if attempt.AttemptID == "" || attempt.PairingID == "" || attempt.CallerDeviceID == "" ||
		attempt.OwnerDeviceID == "" || attempt.State == "" || attempt.CallerICE == nil {
		return DeviceLinkAttempt{}, errors.New("control-plane device-link attempt is incomplete")
	}
	attempt.STUNEndpoints = append([]string(nil), attempt.STUNEndpoints...)
	attempt.CallerICE.Candidates = append([]string(nil), attempt.CallerICE.Candidates...)
	if attempt.OwnerICE != nil {
		attempt.OwnerICE.Candidates = append([]string(nil), attempt.OwnerICE.Candidates...)
	}
	return attempt, nil
}
