package deviceauthority

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ed25519"
	cryptorand "crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	defaultHTTPTimeout           = 30 * time.Second
	defaultOwnerTunnelTokenTTL   = 10 * time.Minute
	maxOwnerTunnelTokenTTL       = 10 * time.Minute
	maxHTTPResponseBodyBytes     = 1 << 20
	deviceIdentityAlgorithm      = "ed25519"
	ensureDeviceAuthorityPath    = "/device-authorities/ensure"
	renewDeviceAuthorityPathFmt  = "/device-authorities/%s/lease/renew"
	enrollGatewayIdentityPathFmt = "/gateway/device-authorities/%s/identity/enroll"
	issueOwnerTunnelTokenPathFmt = "/gateway/device-authorities/%s/owner-tunnel-token"
)

// HTTPDoer is the narrow HTTP dependency used by Client.
type HTTPDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

// RequestMetadata lets a product adapter add its current account, device, or
// lane headers without moving those policies into this package.
type RequestMetadata struct {
	OwnerUserID string
}

// PrepareRequestFunc adds product-owned authentication and device headers.
// Implementations must not retain or mutate the request after returning.
type PrepareRequestFunc func(req *http.Request, metadata RequestMetadata) error

// Config supplies the deployment and product dependencies for a Client.
type Config struct {
	BaseURL        string
	APIPrefix      string
	HTTPClient     HTTPDoer
	PrepareRequest PrepareRequestFunc
	Identities     IdentitySource
	Now            func() time.Time
	Nonce          func() (string, error)
}

// Client executes the Device Authority owner lifecycle wire protocol.
type Client struct {
	baseURL        string
	apiPrefix      string
	httpClient     HTTPDoer
	prepareRequest PrepareRequestFunc
	identities     IdentitySource
	now            func() time.Time
	nonce          func() (string, error)
}

// NewClient validates cfg and constructs an immutable client.
func NewClient(cfg Config) (*Client, error) {
	baseURL, err := normalizeBaseURL(cfg.BaseURL)
	if err != nil {
		return nil, err
	}
	apiPrefix, err := normalizeAPIPrefix(cfg.APIPrefix)
	if err != nil {
		return nil, err
	}
	if cfg.Identities == nil {
		return nil, fmt.Errorf("device authority client requires identity source")
	}
	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultHTTPTimeout}
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	nonce := cfg.Nonce
	if nonce == nil {
		nonce = randomNonce
	}
	return &Client{
		baseURL:        baseURL,
		apiPrefix:      apiPrefix,
		httpClient:     httpClient,
		prepareRequest: cfg.PrepareRequest,
		identities:     cfg.Identities,
		now:            now,
		nonce:          nonce,
	}, nil
}

// EnsureDeviceAuthority resolves or creates the authority for one owner and
// runtime.
func (c *Client) EnsureDeviceAuthority(ctx context.Context, req EnsureDeviceAuthorityRequest) (DeviceAuthorityResult, error) {
	ownerUserID := strings.TrimSpace(req.OwnerUserID)
	runtimeID := strings.TrimSpace(req.RuntimeID)
	if ownerUserID == "" || runtimeID == "" {
		return DeviceAuthorityResult{}, fmt.Errorf("ensure device authority requires owner user id and runtime id")
	}
	var raw ensureDeviceAuthorityWireResponse
	if err := c.doJSON(ctx, http.MethodPost, ensureDeviceAuthorityPath, map[string]string{
		"ownerUserId": ownerUserID,
		"runtimeId":   runtimeID,
	}, &raw, RequestMetadata{OwnerUserID: ownerUserID}); err != nil {
		return DeviceAuthorityResult{}, err
	}
	authorityID := strings.TrimSpace(raw.AuthorityID)
	if authorityID == "" {
		return DeviceAuthorityResult{}, fmt.Errorf("ensure device authority response missing authorityId")
	}
	relay := raw.Relay.descriptor()
	if relay.HostEndpoint == "" || relay.DialEndpoint == "" {
		return DeviceAuthorityResult{}, fmt.Errorf("ensure device authority response missing relay endpoints")
	}
	return DeviceAuthorityResult{
		AuthorityID: authorityID,
		State:       strings.TrimSpace(raw.State),
		OwnerUserID: ownerUserID,
		RuntimeID:   runtimeID,
		Relay:       relay,
		Lease:       raw.Lease.policy(),
		GatewayEnrollment: GatewayEnrollment{
			Proof:     strings.TrimSpace(raw.GatewayEnrollment.Proof),
			ExpiresAt: strings.TrimSpace(raw.GatewayEnrollment.ExpiresAt),
		},
	}, nil
}

// RegisterDeviceGatewayIdentity enrolls the runtime identity selected by the
// configured IdentitySource.
func (c *Client) RegisterDeviceGatewayIdentity(ctx context.Context, req RegisterDeviceGatewayIdentityRequest) (DeviceGatewayIdentityResult, error) {
	authorityID := strings.TrimSpace(req.AuthorityID)
	runtimeID := strings.TrimSpace(req.RuntimeID)
	proof := strings.TrimSpace(req.EnrollmentProof)
	if authorityID == "" || runtimeID == "" || proof == "" {
		return DeviceGatewayIdentityResult{}, fmt.Errorf("register device gateway identity requires authority id, runtime id, and enrollment proof")
	}
	identity, publicKey, err := c.identity(ctx, runtimeID)
	if err != nil {
		return DeviceGatewayIdentityResult{}, err
	}
	path := fmt.Sprintf(enrollGatewayIdentityPathFmt, url.PathEscape(authorityID))
	var raw enrollDeviceGatewayIdentityWireResponse
	if err := c.doJSON(ctx, http.MethodPost, path, map[string]any{
		"authorityId":     authorityID,
		"runtimeId":       runtimeID,
		"enrollmentProof": proof,
		"keyId":           strings.TrimSpace(identity.KeyID),
		"algorithm":       deviceIdentityAlgorithm,
		"publicKey":       base64.RawURLEncoding.EncodeToString(publicKey),
	}, &raw, RequestMetadata{}); err != nil {
		return DeviceGatewayIdentityResult{}, err
	}
	keyID := firstNonEmpty(raw.Identity.KeyID, identity.KeyID)
	if keyID != strings.TrimSpace(identity.KeyID) {
		return DeviceGatewayIdentityResult{}, fmt.Errorf("register device gateway identity response key id %q does not match local key %q", keyID, identity.KeyID)
	}
	responseAuthorityID := firstNonEmpty(raw.Identity.AuthorityID, authorityID)
	if responseAuthorityID != authorityID {
		return DeviceGatewayIdentityResult{}, fmt.Errorf("register device gateway identity response authority id %q does not match request %q", responseAuthorityID, authorityID)
	}
	return DeviceGatewayIdentityResult{
		AuthorityID: responseAuthorityID,
		RuntimeID:   runtimeID,
		IdentityID:  strings.TrimSpace(raw.Identity.IdentityID),
		KeyID:       keyID,
	}, nil
}

// IssueDeviceGatewayOwnerTunnelToken signs and requests a Relay owner-tunnel
// token bound to the runtime's enrolled gateway identity.
func (c *Client) IssueDeviceGatewayOwnerTunnelToken(ctx context.Context, req IssueDeviceGatewayOwnerTunnelTokenRequest) (DeviceGatewayOwnerTunnelTokenResult, error) {
	authorityID := strings.TrimSpace(req.AuthorityID)
	runtimeID := strings.TrimSpace(req.RuntimeID)
	if authorityID == "" || runtimeID == "" {
		return DeviceGatewayOwnerTunnelTokenResult{}, fmt.Errorf("issue device gateway owner tunnel token requires authority id and runtime id")
	}
	identity, _, err := c.identity(ctx, runtimeID)
	if err != nil {
		return DeviceGatewayOwnerTunnelTokenResult{}, err
	}
	ttlSeconds, err := ownerTunnelTTLSeconds(req.TTL)
	if err != nil {
		return DeviceGatewayOwnerTunnelTokenResult{}, err
	}
	nonce, err := c.nonce()
	if err != nil {
		return DeviceGatewayOwnerTunnelTokenResult{}, fmt.Errorf("generate device gateway owner tunnel token nonce: %w", err)
	}
	nonce = strings.TrimSpace(nonce)
	if nonce == "" {
		return DeviceGatewayOwnerTunnelTokenResult{}, fmt.Errorf("generate device gateway owner tunnel token nonce: empty value")
	}
	now := c.now()
	if now.IsZero() {
		return DeviceGatewayOwnerTunnelTokenResult{}, fmt.Errorf("issue device gateway owner tunnel token requires a non-zero clock value")
	}
	timestamp := now.UTC().Format(time.RFC3339Nano)
	targets := append([]string(nil), req.SupportedTargets...)
	payload, err := gatewayOwnerSessionSigningPayload(authorityID, runtimeID, identity.KeyID, nonce, timestamp, ttlSeconds, targets)
	if err != nil {
		return DeviceGatewayOwnerTunnelTokenResult{}, err
	}
	signature, err := identity.Signer.Sign(cryptorand.Reader, []byte(payload), crypto.Hash(0))
	if err != nil {
		return DeviceGatewayOwnerTunnelTokenResult{}, fmt.Errorf("sign device gateway owner tunnel token: %w", err)
	}
	if len(signature) != ed25519.SignatureSize {
		return DeviceGatewayOwnerTunnelTokenResult{}, fmt.Errorf("sign device gateway owner tunnel token: invalid Ed25519 signature length")
	}
	path := fmt.Sprintf(issueOwnerTunnelTokenPathFmt, url.PathEscape(authorityID))
	var raw issueOwnerTunnelTokenWireResponse
	if err := c.doJSON(ctx, http.MethodPost, path, map[string]any{
		"authorityId":      authorityID,
		"runtimeId":        runtimeID,
		"keyId":            strings.TrimSpace(identity.KeyID),
		"nonce":            nonce,
		"timestamp":        timestamp,
		"signature":        base64.RawURLEncoding.EncodeToString(signature),
		"supportedTargets": targets,
		"ttlSeconds":       ttlSeconds,
	}, &raw, RequestMetadata{}); err != nil {
		return DeviceGatewayOwnerTunnelTokenResult{}, err
	}
	token := raw.OwnerTunnelToken
	if strings.TrimSpace(token.Token) == "" {
		return DeviceGatewayOwnerTunnelTokenResult{}, fmt.Errorf("issue device gateway owner tunnel token response missing token")
	}
	responseAuthorityID := firstNonEmpty(raw.AuthorityID, authorityID)
	if responseAuthorityID != authorityID {
		return DeviceGatewayOwnerTunnelTokenResult{}, fmt.Errorf("issue device gateway owner tunnel token response authority id %q does not match request %q", responseAuthorityID, authorityID)
	}
	identityID := strings.TrimSpace(raw.GatewayIdentityID)
	if identityID == "" {
		return DeviceGatewayOwnerTunnelTokenResult{}, fmt.Errorf("issue device gateway owner tunnel token response missing gateway identity id")
	}
	if identityID != strings.TrimSpace(identity.KeyID) {
		return DeviceGatewayOwnerTunnelTokenResult{}, fmt.Errorf("issue device gateway owner tunnel token response gateway identity id %q does not match local key %q", identityID, identity.KeyID)
	}
	return DeviceGatewayOwnerTunnelTokenResult{
		AuthorityID: responseAuthorityID,
		State:       strings.TrimSpace(raw.State),
		Token: Token{
			Value:     strings.TrimSpace(token.Token),
			ExpiresAt: strings.TrimSpace(token.ExpiresAt),
		},
		Relay:      raw.Relay.descriptor(),
		Lease:      raw.Lease.policy(),
		IdentityID: identityID,
	}, nil
}

// RenewDeviceAuthorityLease reports the product-owned VM and owner-tunnel
// status while extending the authority lease.
func (c *Client) RenewDeviceAuthorityLease(ctx context.Context, req RenewDeviceAuthorityLeaseRequest) (RenewDeviceAuthorityLeaseResult, error) {
	authorityID := strings.TrimSpace(req.AuthorityID)
	ownerUserID := strings.TrimSpace(req.OwnerUserID)
	runtimeID := strings.TrimSpace(req.RuntimeID)
	if authorityID == "" || ownerUserID == "" || runtimeID == "" {
		return RenewDeviceAuthorityLeaseResult{}, fmt.Errorf("renew device authority lease requires authority id, owner user id, and runtime id")
	}
	path := fmt.Sprintf(renewDeviceAuthorityPathFmt, url.PathEscape(authorityID))
	var raw renewLeaseWireResponse
	if err := c.doJSON(ctx, http.MethodPost, path, map[string]any{
		"authorityId":       authorityID,
		"ownerUserId":       ownerUserID,
		"runtimeId":         runtimeID,
		"ttlSeconds":        req.TTLSeconds,
		"vmStatus":          strings.TrimSpace(req.VMStatus),
		"ownerTunnelStatus": strings.TrimSpace(req.OwnerTunnelStatus),
	}, &raw, RequestMetadata{OwnerUserID: ownerUserID}); err != nil {
		return RenewDeviceAuthorityLeaseResult{}, err
	}
	responseAuthorityID := strings.TrimSpace(raw.AuthorityID)
	if responseAuthorityID != "" && responseAuthorityID != authorityID {
		return RenewDeviceAuthorityLeaseResult{}, fmt.Errorf("%w: renew response authority id does not match request", ErrResponseBinding)
	}
	return RenewDeviceAuthorityLeaseResult{
		AuthorityID: responseAuthorityID,
		State:       strings.TrimSpace(raw.State),
		RenewedAt:   strings.TrimSpace(raw.RenewedAt),
		ExpiresAt:   strings.TrimSpace(raw.ExpiresAt),
	}, nil
}

func (c *Client) identity(ctx context.Context, runtimeID string) (SigningIdentity, []byte, error) {
	if err := contextError(ctx); err != nil {
		return SigningIdentity{}, nil, err
	}
	identity, err := c.identities.Identity(ctx, runtimeID)
	if err != nil {
		return SigningIdentity{}, nil, fmt.Errorf("resolve device gateway identity: %w", err)
	}
	publicKey, err := validateSigningIdentity(identity)
	if err != nil {
		return SigningIdentity{}, nil, err
	}
	identity.KeyID = strings.TrimSpace(identity.KeyID)
	return identity, publicKey, nil
}

func (c *Client) doJSON(ctx context.Context, method, path string, requestBody, responseBody any, metadata RequestMetadata) error {
	if err := contextError(ctx); err != nil {
		return err
	}
	rawRequest, err := json.Marshal(requestBody)
	if err != nil {
		return fmt.Errorf("marshal device authority request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.endpoint(path), bytes.NewReader(rawRequest))
	if err != nil {
		return fmt.Errorf("create device authority request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if c.prepareRequest != nil {
		if err := c.prepareRequest(req, metadata); err != nil {
			return fmt.Errorf("prepare device authority request: %w", err)
		}
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("device authority request failed: %w", err)
	}
	if resp == nil || resp.Body == nil {
		return fmt.Errorf("device authority request failed: HTTP client returned an empty response")
	}
	defer func() { _ = resp.Body.Close() }()
	responseLimit := int64(maxHTTPResponseBodyBytes + 1)
	if resp.StatusCode >= http.StatusMultipleChoices {
		responseLimit = int64(maxHTTPErrorBodyBytes + 1)
	}
	rawResponse, err := io.ReadAll(io.LimitReader(resp.Body, responseLimit))
	if err != nil {
		return fmt.Errorf("read device authority response: %w", err)
	}
	if resp.StatusCode >= http.StatusMultipleChoices {
		return newHTTPError(resp.StatusCode, rawResponse, resp.Header.Get("Retry-After"))
	}
	if len(rawResponse) > maxHTTPResponseBodyBytes {
		return fmt.Errorf("device authority response exceeds %d bytes", maxHTTPResponseBodyBytes)
	}
	if responseBody == nil || len(bytes.TrimSpace(rawResponse)) == 0 {
		return nil
	}
	if err := json.Unmarshal(rawResponse, responseBody); err != nil {
		return fmt.Errorf("parse device authority response: %w", err)
	}
	return nil
}

func (c *Client) endpoint(path string) string {
	return c.baseURL + c.apiPrefix + path
}

func ownerTunnelTTLSeconds(ttl time.Duration) (int, error) {
	if ttl <= 0 {
		ttl = defaultOwnerTunnelTokenTTL
	}
	seconds := int64(ttl / time.Second)
	if seconds <= 0 {
		seconds = int64(defaultOwnerTunnelTokenTTL / time.Second)
	}
	if seconds > int64(maxOwnerTunnelTokenTTL/time.Second) {
		return 0, fmt.Errorf("device gateway owner tunnel token ttl exceeds 10 minute protocol maximum")
	}
	return int(seconds), nil
}

func normalizeBaseURL(value string) (string, error) {
	value = strings.TrimRight(strings.TrimSpace(value), "/")
	if value == "" {
		return "", fmt.Errorf("device authority client requires base URL")
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return "", fmt.Errorf("parse device authority base URL: %w", err)
	}
	if (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", fmt.Errorf("device authority base URL must use http or https with a host")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("device authority base URL must not contain user info, query, or fragment")
	}
	return value, nil
}

func normalizeAPIPrefix(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", fmt.Errorf("device authority client requires API prefix")
	}
	if !strings.HasPrefix(value, "/") {
		value = "/" + value
	}
	value = strings.TrimRight(value, "/")
	if value == "" || strings.Contains(value, "?") || strings.Contains(value, "#") {
		return "", fmt.Errorf("device authority API prefix must be an absolute URL path")
	}
	return value, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func contextError(ctx context.Context) error {
	if ctx == nil {
		return fmt.Errorf("device authority request requires context")
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("device authority request context: %w", err)
	}
	return nil
}
