package connectormarket

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
	"strconv"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/httpx"
	market "github.com/tutti-os/tutti/packages/connector/market/daemon"
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
}

type CatalogSource struct {
	baseURL            *url.URL
	expectedMarketType string
	httpClient         *http.Client
	authorizeRequest   RequestAuthorizer
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
		client = httpx.NewClient(30 * time.Second)
	}
	return &CatalogSource{baseURL: baseURL, expectedMarketType: expectedMarketType,
		httpClient: client, authorizeRequest: config.AuthorizeRequest}, nil
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
			page, err := source.ListPage(ctx, market.CatalogSourcePageQuery{SectionID: category.CategoryID, PageSize: 100, PageToken: pageToken})
			if err != nil {
				return market.CatalogSnapshot{}, err
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
	if _, err := source.getJSON(ctx, connectorCategoriesPath, url.Values{"itemType": {"connector"}}, &payload); err != nil {
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
	defer response.Body.Close()
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
	decoder := json.NewDecoder(bytes.NewReader(payloadBytes))
	decoder.DisallowUnknownFields()
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
	decoder := json.NewDecoder(bytes.NewReader(manifestBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&connectorManifest); err != nil {
		return market.Release{}, fmt.Errorf("decode connector market manifest: %w", err)
	}
	if connectorManifest.SchemaVersion != "1" || connectorManifest.ItemType != "connector" ||
		connectorManifest.ItemKey != item.ItemKey || connectorManifest.Version != item.Version ||
		!containsString(connectorManifest.SupportedMarkets, source.expectedMarketType) {
		return market.Release{}, errors.New("connector manifest identity or market does not match item")
	}
	if !isSHA256Hex(connectorManifest.Payload.PackageManifestSHA256) {
		return market.Release{}, errors.New("connector manifest package digest is invalid")
	}
	implementation, ok := connectorManifest.Payload.Implementations[source.expectedMarketType]
	if !ok {
		return market.Release{}, errors.New("connector manifest does not provide the configured market implementation")
	}
	releaseDigest := sha256.Sum256([]byte(item.ItemKey + "\x00" + item.Version + "\x00" + item.Artifact.SHA256))
	manifest := market.Manifest{SchemaVersion: "1", DisplayName: connectorManifest.Display.Name,
		Description: connectorManifest.Display.Description, Permissions: connectorManifest.Payload.Permissions,
		Implementation: implementation, AuthorizationKind: connectorManifest.Payload.Authorization.Kind,
		Compatibility: connectorManifest.Payload.Compatibility}
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
	SchemaVersion    string                       `json:"schemaVersion"`
	ItemType         string                       `json:"itemType"`
	ItemKey          string                       `json:"itemKey"`
	Version          string                       `json:"version"`
	Display          wireConnectorDisplay         `json:"display"`
	SupportedMarkets []string                     `json:"supportedMarkets"`
	Payload          wireConnectorManifestPayload `json:"payload"`
}

type wireConnectorDisplay struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

type wireConnectorManifestPayload struct {
	Permissions           []string                         `json:"permissions"`
	PackageManifestSHA256 string                           `json:"packageManifestSha256"`
	Authorization         wireConnectorAuthorization       `json:"authorization"`
	Compatibility         market.CompatibilityRequirements `json:"compatibility"`
	Implementations       map[string]market.Implementation `json:"implementations"`
}

type wireConnectorAuthorization struct {
	Kind string `json:"kind"`
}

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

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
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
