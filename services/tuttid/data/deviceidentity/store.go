package deviceidentity

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	mobileremotebiz "github.com/tutti-os/tutti/services/tuttid/biz/mobileremote"
)

const identitySchemaVersion = 1

type FileStore struct {
	path     string
	deviceID string
	now      func() time.Time
	mu       sync.Mutex
}

type identityFile struct {
	SchemaVersion int    `json:"schemaVersion"`
	DeviceID      string `json:"deviceId"`
	Algorithm     string `json:"algorithm"`
	PrivateKey    string `json:"privateKey"`
	CreatedAt     string `json:"createdAt"`
}

func NewFileStore(path, deviceID string) *FileStore {
	return &FileStore{
		path: strings.TrimSpace(path), deviceID: strings.TrimSpace(deviceID),
		now: func() time.Time { return time.Now().UTC() },
	}
}

func (s *FileStore) LoadOrCreate(_ context.Context) (mobileremotebiz.DeviceIdentity, error) {
	if s == nil || s.path == "" || s.deviceID == "" {
		return mobileremotebiz.DeviceIdentity{}, errors.New("device identity store is not configured")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	identity, err := s.load()
	if err == nil {
		return identity, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return mobileremotebiz.DeviceIdentity{}, err
	}
	return s.create()
}

func (s *FileStore) load() (mobileremotebiz.DeviceIdentity, error) {
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return mobileremotebiz.DeviceIdentity{}, err
	}
	var stored identityFile
	if err := json.Unmarshal(raw, &stored); err != nil {
		return mobileremotebiz.DeviceIdentity{}, fmt.Errorf("parse device identity: %w", err)
	}
	if stored.SchemaVersion != identitySchemaVersion ||
		strings.TrimSpace(stored.DeviceID) != s.deviceID ||
		strings.TrimSpace(stored.Algorithm) != mobileremotebiz.IdentityAlgorithmEd25519 {
		return mobileremotebiz.DeviceIdentity{}, errors.New("stored device identity metadata is invalid")
	}
	privateKey, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(stored.PrivateKey))
	if err != nil || len(privateKey) != ed25519.PrivateKeySize ||
		base64.RawURLEncoding.EncodeToString(privateKey) != strings.TrimSpace(stored.PrivateKey) {
		return mobileremotebiz.DeviceIdentity{}, errors.New("stored device identity key is invalid")
	}
	createdAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(stored.CreatedAt))
	if err != nil {
		return mobileremotebiz.DeviceIdentity{}, errors.New("stored device identity creation time is invalid")
	}
	privateCopy := append(ed25519.PrivateKey(nil), privateKey...)
	publicKey, ok := privateCopy.Public().(ed25519.PublicKey)
	if !ok || len(publicKey) != ed25519.PublicKeySize {
		return mobileremotebiz.DeviceIdentity{}, errors.New("stored device identity public key is invalid")
	}
	return mobileremotebiz.DeviceIdentity{
		DeviceID: s.deviceID, PrivateKey: privateCopy,
		PublicKey: append(ed25519.PublicKey(nil), publicKey...), CreatedAt: createdAt.UTC(),
	}, nil
}

func (s *FileStore) create() (mobileremotebiz.DeviceIdentity, error) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return mobileremotebiz.DeviceIdentity{}, fmt.Errorf("generate device identity: %w", err)
	}
	createdAt := s.now().UTC()
	stored := identityFile{
		SchemaVersion: identitySchemaVersion,
		DeviceID:      s.deviceID,
		Algorithm:     mobileremotebiz.IdentityAlgorithmEd25519,
		PrivateKey:    base64.RawURLEncoding.EncodeToString(privateKey),
		CreatedAt:     createdAt.Format(time.RFC3339Nano),
	}
	raw, err := json.Marshal(stored)
	if err != nil {
		return mobileremotebiz.DeviceIdentity{}, fmt.Errorf("encode device identity: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return mobileremotebiz.DeviceIdentity{}, fmt.Errorf("create device identity directory: %w", err)
	}
	temp, err := os.CreateTemp(filepath.Dir(s.path), ".device-identity-*.tmp")
	if err != nil {
		return mobileremotebiz.DeviceIdentity{}, fmt.Errorf("create temporary device identity: %w", err)
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return mobileremotebiz.DeviceIdentity{}, fmt.Errorf("protect temporary device identity: %w", err)
	}
	if _, err := temp.Write(append(raw, '\n')); err != nil {
		_ = temp.Close()
		return mobileremotebiz.DeviceIdentity{}, fmt.Errorf("write temporary device identity: %w", err)
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return mobileremotebiz.DeviceIdentity{}, fmt.Errorf("sync temporary device identity: %w", err)
	}
	if err := temp.Close(); err != nil {
		return mobileremotebiz.DeviceIdentity{}, fmt.Errorf("close temporary device identity: %w", err)
	}
	if err := os.Rename(tempPath, s.path); err != nil {
		return mobileremotebiz.DeviceIdentity{}, fmt.Errorf("install device identity: %w", err)
	}
	return mobileremotebiz.DeviceIdentity{
		DeviceID: s.deviceID, PrivateKey: append(ed25519.PrivateKey(nil), privateKey...),
		PublicKey: append(ed25519.PublicKey(nil), publicKey...), CreatedAt: createdAt,
	}, nil
}
