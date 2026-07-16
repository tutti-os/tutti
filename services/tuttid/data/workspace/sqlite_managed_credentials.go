package workspace

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	managedcredentialsbiz "github.com/tutti-os/tutti/services/tuttid/biz/managedcredentials"
)

func (s *SQLiteStore) ListManagedModelProviderConfigs(ctx context.Context, workspaceID string) ([]managedcredentialsbiz.ProviderConfig, error) {
	if s == nil || s.writeDB == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	rows, err := s.readDB.QueryContext(ctx, `
SELECT workspace_id, provider_id, enabled, api_key_ciphertext, base_url, models_json, updated_at_unix_ms
FROM managed_model_provider_credentials
WHERE workspace_id = ?
ORDER BY provider_id
`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list managed model provider configs: %w", err)
	}
	defer rows.Close()

	var configs []managedcredentialsbiz.ProviderConfig
	for rows.Next() {
		config, err := scanManagedModelProviderConfig(rows)
		if err != nil {
			return nil, err
		}
		configs = append(configs, config)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list managed model provider config rows: %w", err)
	}
	return configs, nil
}

func (s *SQLiteStore) GetManagedModelProviderConfig(ctx context.Context, workspaceID string, providerID managedcredentialsbiz.ProviderID) (managedcredentialsbiz.ProviderConfig, error) {
	if s == nil || s.writeDB == nil {
		return managedcredentialsbiz.ProviderConfig{}, errors.New("workspace database is not initialized")
	}
	row := s.readDB.QueryRowContext(ctx, `
SELECT workspace_id, provider_id, enabled, api_key_ciphertext, base_url, models_json, updated_at_unix_ms
FROM managed_model_provider_credentials
WHERE workspace_id = ? AND provider_id = ?
`, workspaceID, providerID)
	config, err := scanManagedModelProviderConfig(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return managedcredentialsbiz.ProviderConfig{}, ErrWorkspaceAppNotFound
		}
		return managedcredentialsbiz.ProviderConfig{}, err
	}
	return config, nil
}

func (s *SQLiteStore) PutManagedModelProviderConfig(ctx context.Context, config managedcredentialsbiz.ProviderConfig) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	modelsJSON, err := json.Marshal(config.Models)
	if err != nil {
		return fmt.Errorf("marshal managed provider models: %w", err)
	}
	ciphertext, err := encryptManagedCredential(config.APIKey)
	if err != nil {
		return err
	}
	now := unixMs(time.Now().UTC())
	_, err = s.writeDB.ExecContext(ctx, `
INSERT INTO managed_model_provider_credentials (
  workspace_id, provider_id, enabled, api_key_ciphertext, base_url, models_json, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, provider_id) DO UPDATE SET
  enabled = excluded.enabled,
  api_key_ciphertext = excluded.api_key_ciphertext,
  base_url = excluded.base_url,
  models_json = excluded.models_json,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, config.WorkspaceID, string(config.Provider), boolInt(config.Enabled), ciphertext, config.BaseURL, string(modelsJSON), now)
	if err != nil {
		return fmt.Errorf("put managed model provider config: %w", err)
	}
	return nil
}

func (s *SQLiteStore) DeleteManagedModelProviderConfig(ctx context.Context, workspaceID string, providerID managedcredentialsbiz.ProviderID) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	_, err := s.writeDB.ExecContext(ctx, `
DELETE FROM managed_model_provider_credentials
WHERE workspace_id = ? AND provider_id = ?
`, workspaceID, providerID)
	if err != nil {
		return fmt.Errorf("delete managed model provider config: %w", err)
	}
	return nil
}

func (s *SQLiteStore) PutManagedModelGrant(ctx context.Context, grant managedcredentialsbiz.Grant) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	providersJSON, err := json.Marshal(grant.ProviderIDs)
	if err != nil {
		return fmt.Errorf("marshal managed grant providers: %w", err)
	}
	scopesJSON, err := json.Marshal(grant.Scopes)
	if err != nil {
		return fmt.Errorf("marshal managed grant scopes: %w", err)
	}
	_, err = s.writeDB.ExecContext(ctx, `
INSERT INTO managed_model_app_grants (
  workspace_id, app_id, grant_ref, provider_ids_json, scopes_json, created_at_unix_ms, expires_at_unix_ms, revoked_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
ON CONFLICT(workspace_id, app_id, grant_ref) DO UPDATE SET
  provider_ids_json = excluded.provider_ids_json,
  scopes_json = excluded.scopes_json,
  expires_at_unix_ms = excluded.expires_at_unix_ms,
  revoked_at_unix_ms = NULL
`, grant.WorkspaceID, grant.AppID, grant.GrantRef, string(providersJSON), string(scopesJSON), unixMs(grant.CreatedAt), unixMs(grant.ExpiresAt))
	if err != nil {
		return fmt.Errorf("put managed model grant: %w", err)
	}
	return nil
}

func (s *SQLiteStore) GetManagedModelGrant(ctx context.Context, workspaceID string, appID string, grantRef string) (managedcredentialsbiz.Grant, error) {
	if s == nil || s.writeDB == nil {
		return managedcredentialsbiz.Grant{}, errors.New("workspace database is not initialized")
	}
	row := s.readDB.QueryRowContext(ctx, `
SELECT workspace_id, app_id, grant_ref, provider_ids_json, scopes_json, created_at_unix_ms, expires_at_unix_ms, revoked_at_unix_ms
FROM managed_model_app_grants
WHERE workspace_id = ? AND app_id = ? AND grant_ref = ?
`, workspaceID, appID, grantRef)
	var grant managedcredentialsbiz.Grant
	var providersJSON string
	var scopesJSON string
	var createdAtUnixMS int64
	var expiresAtUnixMS int64
	var revokedAt sql.NullInt64
	if err := row.Scan(&grant.WorkspaceID, &grant.AppID, &grant.GrantRef, &providersJSON, &scopesJSON, &createdAtUnixMS, &expiresAtUnixMS, &revokedAt); err != nil {
		return managedcredentialsbiz.Grant{}, err
	}
	_ = json.Unmarshal([]byte(providersJSON), &grant.ProviderIDs)
	_ = json.Unmarshal([]byte(scopesJSON), &grant.Scopes)
	grant.CreatedAt = time.UnixMilli(createdAtUnixMS).UTC()
	grant.ExpiresAt = time.UnixMilli(expiresAtUnixMS).UTC()
	grant.RevokedAt = nullableUnixMs(revokedAt)
	return grant, nil
}

func (s *SQLiteStore) RevokeManagedModelGrant(ctx context.Context, workspaceID string, appID string, grantRef string) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	_, err := s.writeDB.ExecContext(ctx, `
UPDATE managed_model_app_grants
SET revoked_at_unix_ms = ?
WHERE workspace_id = ? AND app_id = ? AND grant_ref = ?
`, unixMs(time.Now().UTC()), workspaceID, appID, grantRef)
	if err != nil {
		return fmt.Errorf("revoke managed model grant: %w", err)
	}
	return nil
}

func (s *SQLiteStore) DeleteManagedModelGrant(ctx context.Context, workspaceID string, appID string, grantRef string) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	_, err := s.writeDB.ExecContext(ctx, `
DELETE FROM managed_model_app_grants
WHERE workspace_id = ? AND app_id = ? AND grant_ref = ?
`, workspaceID, appID, grantRef)
	if err != nil {
		return fmt.Errorf("delete managed model grant: %w", err)
	}
	return nil
}

type managedProviderScanner interface {
	Scan(dest ...any) error
}

func scanManagedModelProviderConfig(row managedProviderScanner) (managedcredentialsbiz.ProviderConfig, error) {
	var config managedcredentialsbiz.ProviderConfig
	var providerID string
	var enabled int
	var ciphertext string
	var modelsJSON string
	var updatedAtUnixMS int64
	if err := row.Scan(&config.WorkspaceID, &providerID, &enabled, &ciphertext, &config.BaseURL, &modelsJSON, &updatedAtUnixMS); err != nil {
		return managedcredentialsbiz.ProviderConfig{}, err
	}
	apiKey, err := decryptManagedCredential(ciphertext)
	if err != nil {
		return managedcredentialsbiz.ProviderConfig{}, err
	}
	config.Provider = managedcredentialsbiz.ProviderID(providerID)
	config.Enabled = enabled != 0
	config.APIKey = apiKey
	_ = json.Unmarshal([]byte(modelsJSON), &config.Models)
	config.UpdatedAt = time.UnixMilli(updatedAtUnixMS).UTC()
	return config, nil
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func managedCredentialKey() []byte {
	seed := strings.TrimSpace(os.Getenv("TUTTI_MANAGED_CREDENTIAL_SECRET"))
	if seed == "" {
		hostname, _ := os.Hostname()
		userConfigDir, _ := os.UserConfigDir()
		seed = "tutti-managed-credentials:" + hostname + ":" + userConfigDir
	}
	sum := sha256.Sum256([]byte(seed))
	return sum[:]
}

func encryptManagedCredential(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	block, err := aes.NewCipher(managedCredentialKey())
	if err != nil {
		return "", fmt.Errorf("create managed credential cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create managed credential gcm: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("create managed credential nonce: %w", err)
	}
	ciphertext := gcm.Seal(nonce, nonce, []byte(value), nil)
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

func decryptManagedCredential(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	raw, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return "", fmt.Errorf("decode managed credential: %w", err)
	}
	block, err := aes.NewCipher(managedCredentialKey())
	if err != nil {
		return "", fmt.Errorf("create managed credential cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create managed credential gcm: %w", err)
	}
	if len(raw) < gcm.NonceSize() {
		return "", errors.New("managed credential ciphertext is malformed")
	}
	nonce := raw[:gcm.NonceSize()]
	ciphertext := raw[gcm.NonceSize():]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt managed credential: %w", err)
	}
	return string(plaintext), nil
}
