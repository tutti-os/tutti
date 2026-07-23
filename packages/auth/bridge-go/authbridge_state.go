package authbridge

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
)

type bridgeState struct {
	Version           int    `json:"v"`
	Flow              string `json:"flow"`
	AttemptID         string `json:"attemptId"`
	LocalServerOrigin string `json:"localServerOrigin"`
	BridgeToken       string `json:"bridgeToken"`
	AppID             string `json:"appId"`
	AppCallbackURL    string `json:"appCallbackUrl"`
	DeviceID          string `json:"deviceId,omitempty"`
	DeviceName        string `json:"deviceName,omitempty"`
	ClientVersion     string `json:"clientVersion,omitempty"`
	Hostname          string `json:"hostname,omitempty"`
}

func encodeBridgeState(state bridgeState) (string, error) {
	raw, err := json.Marshal(state)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func decodeBridgeState(raw string) (bridgeState, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return bridgeState{}, err
	}
	var state bridgeState
	if err := json.Unmarshal(decoded, &state); err != nil {
		return bridgeState{}, err
	}
	if state.Version != bridgeStateVersion || state.Flow != bridgeFlowDesktop || state.AttemptID == "" || state.BridgeToken == "" {
		return bridgeState{}, errors.New("invalid bridge state")
	}
	return state, nil
}

func buildLoginURL(authLoginURL string, state string) string {
	u, _ := url.Parse(authLoginURL)
	u.Path = "/auth/login"
	u.RawQuery = ""
	u.Fragment = ""
	q := u.Query()
	q.Set("state", state)
	u.RawQuery = q.Encode()
	return u.String()
}
