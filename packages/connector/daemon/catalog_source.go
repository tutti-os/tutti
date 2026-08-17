package daemon

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"runtime"
	"strconv"
	"strings"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/host"
)

const connectorCatalogPath = "/v1/market/items"
const connectorCategoriesPath = "/v1/market/categories"
const maxCatalogResponseBytes = 8 << 20

type RequestAuthorizer func(*http.Request) error

type CatalogSourceConfig struct {
	BaseURL            string
	ExpectedMarketType string
	HTTPClient         *http.Client
	AuthorizeRequest   RequestAuthorizer
	// ExecutionTarget selects a Connector v3 or v4 target. Empty defaults to the
	// daemon process GOOS/GOARCH, which is the correct target for desktop Tutti.
	ExecutionTarget    string
	HostProduct        string
	HostVersion        string
	MaxConnectorSchema int
	HostCapabilities   []string
}

type CatalogSource struct {
	baseURL            *url.URL
	expectedMarketType string
	httpClient         *http.Client
	authorizeRequest   RequestAuthorizer
	executionTarget    string
	hostProduct        string
	hostVersion        string
	maxConnectorSchema int
	hostCapabilities   []string
}

var _ market.CatalogSource = (*CatalogSource)(nil)

func NewCatalogSource(config CatalogSourceConfig) (*CatalogSource, error) {
	baseURL, err := url.Parse(strings.TrimSpace(config.BaseURL))
	if err != nil || baseURL.Scheme == "" || baseURL.Host == "" {
		return nil, errors.New("connector market base URL must be an absolute URL")
	}
	if baseURL.Scheme != "https" && (baseURL.Scheme != "http" || !isLoopbackHost(baseURL.Hostname())) {
		return nil, errors.New("connector market base URL must use https (http is allowed only for loopback tests)")
	}
	expectedMarketType := strings.ToLower(strings.TrimSpace(config.ExpectedMarketType))
	if expectedMarketType != "domestic" && expectedMarketType != "overseas" {
		return nil, errors.New("connector market type must be domestic or overseas")
	}
	client := config.HTTPClient
	if client == nil {
		return nil, errors.New("connector market HTTP client is required")
	}
	executionTarget := strings.TrimSpace(config.ExecutionTarget)
	var executionTargetErr error
	if executionTarget == "" {
		executionTarget, executionTargetErr = market.ExecutionTarget(runtime.GOOS, runtime.GOARCH)
	} else {
		executionTarget, executionTargetErr = market.NormalizeExecutionTarget(executionTarget)
	}
	if executionTargetErr != nil {
		return nil, executionTargetErr
	}
	return &CatalogSource{baseURL: baseURL, expectedMarketType: expectedMarketType,
		httpClient: client, authorizeRequest: config.AuthorizeRequest, executionTarget: executionTarget,
		hostProduct: strings.TrimSpace(config.HostProduct), hostVersion: strings.TrimSpace(config.HostVersion),
		maxConnectorSchema: config.MaxConnectorSchema, hostCapabilities: append([]string(nil), config.HostCapabilities...)}, nil
}

func (source *CatalogSource) Refresh(ctx context.Context) (market.CatalogSnapshot, error) {
	categories, err := source.ListCategories(ctx)
	if err != nil {
		return market.CatalogSnapshot{}, err
	}
	releases := make([]market.Release, 0)
	seen := make(map[string]struct{})
	primarySections := 0
	for _, category := range categories {
		if category.Kind != "category" {
			continue
		}
		primarySections++
		pageToken := ""
		seenPageTokens := make(map[string]struct{})
		for {
			page, pageErr := source.ListPage(ctx, market.CatalogSourcePageQuery{SectionID: category.CategoryID, PageSize: 100, PageToken: pageToken})
			if pageErr != nil {
				return market.CatalogSnapshot{}, pageErr
			}
			for _, entry := range page.Entries {
				if _, exists := seen[entry.Release.ConnectorKey]; exists {
					return market.CatalogSnapshot{}, errors.New("connector market catalog contains duplicate primary placements")
				}
				seen[entry.Release.ConnectorKey] = struct{}{}
				releases = append(releases, entry.Release)
			}
			if page.NextPageToken == "" {
				break
			}
			if _, exists := seenPageTokens[page.NextPageToken]; exists {
				return market.CatalogSnapshot{}, errors.New("connector market catalog returned a cyclic page token")
			}
			seenPageTokens[page.NextPageToken] = struct{}{}
			pageToken = page.NextPageToken
		}
	}
	if primarySections == 0 {
		return market.CatalogSnapshot{}, errors.New("connector market catalog returned no primary categories")
	}
	revisionHash := sha256.New()
	for _, release := range releases {
		_, _ = io.WriteString(revisionHash, release.ConnectorKey)
		_, _ = io.WriteString(revisionHash, "\x00")
		_, _ = io.WriteString(revisionHash, release.ReleaseDigest)
		_, _ = io.WriteString(revisionHash, "\n")
	}
	return market.CatalogSnapshot{SourceRevision: hex.EncodeToString(revisionHash.Sum(nil)), Releases: releases}, nil
}

func (source *CatalogSource) ListCategories(ctx context.Context) ([]market.CatalogCategory, error) {
	var payload wireMarketCategoriesResponse
	query := url.Values{"itemType": {"connector"}}
	source.addHostCohort(query)
	if _, err := source.getJSON(ctx, connectorCategoriesPath, query, &payload); err != nil {
		return nil, err
	}
	if payload.MarketType != source.expectedMarketType {
		return nil, errors.New("connector market type does not match configured market")
	}
	categories := make([]market.CatalogCategory, 0, len(payload.Categories))
	seen := make(map[string]struct{}, len(payload.Categories))
	for _, category := range payload.Categories {
		if strings.TrimSpace(category.CategoryID) == "" || (category.Kind != "category" && category.Kind != "featured") || category.ItemCount < 0 {
			return nil, errors.New("connector market category is invalid")
		}
		if _, exists := seen[category.CategoryID]; exists {
			return nil, errors.New("connector market category is duplicated")
		}
		seen[category.CategoryID] = struct{}{}
		categories = append(categories, market.CatalogCategory{CategoryID: category.CategoryID, Kind: category.Kind, SortOrder: category.SortOrder, ItemCount: int64(category.ItemCount)})
	}
	return categories, nil
}

func (source *CatalogSource) ListPage(ctx context.Context, input market.CatalogSourcePageQuery) (market.CatalogSourcePage, error) {
	query := url.Values{
		"itemType":  {"connector"},
		"sectionId": {strings.TrimSpace(input.SectionID)},
		"pageSize":  {strconv.Itoa(input.PageSize)},
	}
	if token := strings.TrimSpace(input.PageToken); token != "" {
		query.Set("pageToken", token)
	}
	source.addHostCohort(query)
	var payload wireMarketResponse
	if _, err := source.getJSON(ctx, connectorCatalogPath, query, &payload); err != nil {
		return market.CatalogSourcePage{}, err
	}
	if payload.MarketType != source.expectedMarketType {
		return market.CatalogSourcePage{}, errors.New("connector market type does not match configured market")
	}
	entries := make([]market.CatalogEntry, 0, len(payload.Items))
	for _, item := range payload.Items {
		release, err := source.mapItem(item)
		if err != nil {
			return market.CatalogSourcePage{}, err
		}
		if strings.TrimSpace(item.CategoryID) == "" {
			return market.CatalogSourcePage{}, errors.New("connector market item category is missing")
		}
		entries = append(entries, market.CatalogEntry{CategoryID: item.CategoryID, Featured: item.Featured, Release: release})
	}
	return market.CatalogSourcePage{SectionID: strings.TrimSpace(input.SectionID), Entries: entries, NextPageToken: payload.NextPageToken}, nil
}

func (source *CatalogSource) addHostCohort(query url.Values) {
	if source == nil || strings.TrimSpace(source.hostProduct) == "" || strings.TrimSpace(source.hostVersion) == "" || source.maxConnectorSchema <= 0 {
		return
	}
	query.Set("hostProduct", source.hostProduct)
	query.Set("hostVersion", source.hostVersion)
	query.Set("executionTarget", source.executionTarget)
	query.Set("maxConnectorSchema", strconv.Itoa(source.maxConnectorSchema))
	for _, capability := range source.hostCapabilities {
		query.Add("hostCapabilities", capability)
	}
}

func (source *CatalogSource) getJSON(ctx context.Context, requestPath string, query url.Values, target any) ([]byte, error) {
	joined, err := url.JoinPath(source.baseURL.String(), requestPath)
	if err != nil {
		return nil, fmt.Errorf("build connector market catalog URL: %w", err)
	}
	endpoint, err := url.Parse(joined)
	if err != nil {
		return nil, fmt.Errorf("parse connector market catalog URL: %w", err)
	}
	endpoint.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	if source.authorizeRequest != nil {
		if err := source.authorizeRequest(request); err != nil {
			return nil, err
		}
	}
	response, err := source.httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("request connector market catalog: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 4<<10))
		return nil, fmt.Errorf("request connector market catalog: status %d: %s", response.StatusCode, strings.TrimSpace(string(message)))
	}
	payloadBytes, err := io.ReadAll(io.LimitReader(response.Body, maxCatalogResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(payloadBytes) > maxCatalogResponseBytes {
		return nil, errors.New("decode connector market catalog: response exceeds size limit")
	}
	// This is a remote API client boundary. Ignore additive response fields and
	// validate only the values the client consumes; manifest major versions
	// remain the compatibility boundary for semantic changes.
	decoder := json.NewDecoder(bytes.NewReader(payloadBytes))
	if err := decoder.Decode(target); err != nil {
		return nil, fmt.Errorf("decode connector market catalog: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("decode connector market catalog: trailing JSON value")
	}
	return payloadBytes, nil
}

func (source *CatalogSource) mapItem(item wireMarketItem) (market.Release, error) {
	if item.ItemType != "connector" || item.ItemKey == "" || item.Version == "" || item.Artifact == nil || !safeArtifactKey(item.Artifact.Key) {
		return market.Release{}, errors.New("connector market item identity is incomplete")
	}
	manifestBytes, err := json.Marshal(item.Manifest)
	if err != nil {
		return market.Release{}, err
	}
	var connectorManifest wireConnectorMarketManifest
	// Connector market manifests are extensible. Unknown fields cannot alter
	// the semantics of known fields; breaking changes require a new major.
	decoder := json.NewDecoder(bytes.NewReader(manifestBytes))
	if err := decoder.Decode(&connectorManifest); err != nil {
		return market.Release{}, fmt.Errorf("decode connector market manifest: %w", err)
	}
	if connectorManifest.ItemType != "connector" || connectorManifest.ItemKey != item.ItemKey || connectorManifest.Version != item.Version {
		return market.Release{}, errors.New("connector manifest identity does not match item")
	}
	if !isSHA256Hex(connectorManifest.Payload.PackageManifestSHA256) {
		return market.Release{}, errors.New("connector manifest package digest is invalid")
	}
	implementation, err := source.resolveManifestImplementation(connectorManifest)
	if err != nil {
		return market.Release{}, err
	}
	authorizationInteraction, err := connectorManifest.Payload.Authorization.interaction()
	if err != nil {
		return market.Release{}, err
	}
	releaseDigest := sha256.Sum256([]byte(item.ItemKey + "\x00" + item.Version + "\x00" + item.Artifact.SHA256))
	iconURL := connectorManifest.Display.IconURL
	if strings.TrimSpace(iconURL) == "" {
		iconURL = legacyConnectorIconURL
	}
	// The server's v2 envelope is the generic, market-neutral publication
	// contract. V3 and v4 select one target first. All project into the stable host
	// manifest contract; these schema versions describe different boundaries.
	manifest := market.Manifest{SchemaVersion: "1", DisplayName: connectorManifest.Display.Name, IconURL: iconURL,
		Description: connectorManifest.Display.Description, AgentRouting: connectorManifest.Payload.AgentRouting,
		Permissions:          connectorManifest.Payload.Permissions,
		RequiredCapabilities: connectorManifest.Payload.RequiredCapabilities,
		Implementation:       implementation, AuthorizationKind: connectorManifest.Payload.Authorization.Kind,
		AuthorizationInteraction: authorizationInteraction,
		Compatibility:            connectorManifest.Payload.Compatibility}
	release := market.Release{SchemaVersion: "1", ReleaseID: item.ItemKey + "@" + item.Version,
		ConnectorKey: item.ItemKey, Version: item.Version,
		ReleaseDigest: hex.EncodeToString(releaseDigest[:]), ManifestDigest: connectorManifest.Payload.PackageManifestSHA256,
		Manifest: manifest, Artifact: market.Artifact{Key: item.Artifact.Key, SHA256: item.Artifact.SHA256,
			SizeBytes: int64(item.Artifact.SizeBytes), MediaType: artifactMediaType(item.Artifact.Key)},
		PublishedAt: time.UnixMilli(int64(item.PublishedAtMS)).UTC(), Status: market.ReleaseStatusAvailable}
	if err := market.ValidateReleaseShape(release); err != nil {
		return market.Release{}, err
	}
	return release, nil
}

func (source *CatalogSource) resolveManifestImplementation(manifest wireConnectorMarketManifest) (market.Implementation, error) {
	payload := manifest.Payload
	switch manifest.SchemaVersion {
	case "2":
		if payload.Implementation == nil || len(payload.TargetImplementations) != 0 {
			return market.Implementation{}, errors.New("connector v2 manifest must provide one market-neutral implementation")
		}
		return *payload.Implementation, nil
	case "3", "4":
		if payload.Implementation != nil || len(payload.TargetImplementations) == 0 {
			return market.Implementation{}, errors.New("targeted connector manifest must provide targetImplementations")
		}
		return market.ResolveTargetImplementation(source.executionTarget, payload.TargetImplementations)
	default:
		return market.Implementation{}, fmt.Errorf("connector manifest schemaVersion %q is unsupported", manifest.SchemaVersion)
	}
}

type wireMarketResponse struct {
	MarketType    string           `json:"marketType"`
	Items         []wireMarketItem `json:"items"`
	NextPageToken string           `json:"nextPageToken"`
}

type wireMarketCategoriesResponse struct {
	MarketType string               `json:"marketType"`
	Categories []wireMarketCategory `json:"categories"`
}

type wireMarketCategory struct {
	CategoryID string    `json:"categoryId"`
	Kind       string    `json:"kind"`
	SortOrder  int32     `json:"sortOrder"`
	ItemCount  wireInt64 `json:"itemCount"`
}

type wireMarketItem struct {
	ItemType      string         `json:"itemType"`
	ItemKey       string         `json:"itemKey"`
	Version       string         `json:"version"`
	CommitSHA     string         `json:"commitSha"`
	Artifact      *wireArtifact  `json:"artifact"`
	Manifest      map[string]any `json:"manifest"`
	PublishedAtMS wireInt64      `json:"publishedAtMs"`
	CategoryID    string         `json:"categoryId"`
	Featured      bool           `json:"featured"`
}

type wireArtifact struct {
	Key       string    `json:"key"`
	SHA256    string    `json:"sha256"`
	SizeBytes wireInt64 `json:"sizeBytes"`
}

// Kratos/protojson encodes int64 fields as JSON strings. Accepting numeric
// literals too keeps local tests and non-protobuf adapters straightforward.
type wireInt64 int64

func (value *wireInt64) UnmarshalJSON(payload []byte) error {
	text := strings.TrimSpace(string(payload))
	if len(text) >= 2 && text[0] == '"' && text[len(text)-1] == '"' {
		text = text[1 : len(text)-1]
	}
	parsed, err := strconv.ParseInt(text, 10, 64)
	if err != nil {
		return fmt.Errorf("decode market int64: %w", err)
	}
	*value = wireInt64(parsed)
	return nil
}

type wireConnectorMarketManifest struct {
	SchemaVersion string                       `json:"schemaVersion"`
	ItemType      string                       `json:"itemType"`
	ItemKey       string                       `json:"itemKey"`
	Version       string                       `json:"version"`
	Display       wireConnectorDisplay         `json:"display"`
	Payload       wireConnectorManifestPayload `json:"payload"`
}

type wireConnectorDisplay struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	IconURL     string `json:"iconUrl"`
}

type wireConnectorManifestPayload struct {
	Permissions           []string                         `json:"permissions"`
	RequiredCapabilities  []string                         `json:"requiredCapabilities"`
	AgentRouting          *market.AgentRouting             `json:"agentRouting,omitempty"`
	PackageManifestSHA256 string                           `json:"packageManifestSha256"`
	Authorization         wireConnectorAuthorization       `json:"authorization"`
	Compatibility         market.CompatibilityRequirements `json:"compatibility"`
	Implementation        *market.Implementation           `json:"implementation,omitempty"`
	TargetImplementations map[string]market.Implementation `json:"targetImplementations,omitempty"`
}

type wireConnectorAuthorization struct {
	Kind    string                             `json:"kind"`
	Methods []wireConnectorAuthorizationMethod `json:"methods,omitempty"`
}

type wireConnectorAuthorizationMethod struct {
	Interaction json.RawMessage `json:"interaction,omitempty"`
}

func (authorization wireConnectorAuthorization) interaction() (json.RawMessage, error) {
	var selected json.RawMessage
	for _, method := range authorization.Methods {
		if len(method.Interaction) == 0 || string(method.Interaction) == "null" {
			continue
		}
		if len(selected) != 0 {
			return nil, errors.New("connector authorization must declare at most one interaction")
		}
		selected = append(json.RawMessage(nil), method.Interaction...)
	}
	return selected, nil
}

const legacyConnectorIconURL = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTQiIGZpbGw9IiM2YjcyODAiLz48cGF0aCBkPSJNMTggMjBoMjh2MjRIMTh6IiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjQiLz48L3N2Zz4="

func artifactMediaType(key string) string {
	switch {
	case strings.HasSuffix(strings.ToLower(key), ".zip"):
		return "application/zip"
	case strings.HasSuffix(strings.ToLower(key), ".tar.gz"), strings.HasSuffix(strings.ToLower(key), ".tgz"):
		return "application/gzip"
	default:
		return "application/octet-stream"
	}
}

func isLoopbackHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func safeArtifactKey(key string) bool {
	cleaned := path.Clean(strings.TrimSpace(key))
	return cleaned != "." && cleaned != ".." && cleaned == key && !path.IsAbs(cleaned) && !strings.HasPrefix(cleaned, "../") && !strings.Contains(cleaned, "\\")
}

func isSHA256Hex(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}
