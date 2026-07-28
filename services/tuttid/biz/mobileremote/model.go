package mobileremote

import (
	"crypto/ed25519"
	"time"
)

const (
	IdentityAlgorithmEd25519 = "ed25519"
	PairingProtocolVersion   = 1
)

type DeviceIdentity struct {
	DeviceID   string
	PrivateKey ed25519.PrivateKey
	PublicKey  ed25519.PublicKey
	CreatedAt  time.Time
}

type PairingChallenge struct {
	ChallengeID            string
	TargetUserDeviceID     string
	ControllerUserDeviceID string
	State                  string
	PairingID              string
	Revision               uint64
	ExpiresAt              time.Time
}

type DevicePairing struct {
	PairingID              string
	ControllerUserDeviceID string
	TargetUserDeviceID     string
	State                  string
	Revision               uint64
	ConfirmedAt            time.Time
	RevokedAt              *time.Time
}
