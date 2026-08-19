package catalog

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
	"path"
	"runtime"
	"strings"
	"time"

	marketclient "github.com/tutti-os/tutti/packages/clients/market-go"
	marketv1 "github.com/tutti-os/tutti/packages/clients/market-go/generated/sandbox/v1"
	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

const maxCatalogResponseBytes = marketclient.MaxResponseBodyBytes

type RequestAuthorizer func(*http.Request) error

type CatalogSourceConfig struct {
	BaseURL            string
	ExpectedMarketType string
	HTTPClient         *http.Client
	AuthorizeRequest   RequestAuthorizer
	// ExecutionTarget selects a Connector v3 target. Empty defaults to the
	// daemon process GOOS/GOARCH, which is the correct target for desktop Tutti.
	ExecutionTarget string
}

type CatalogSource struct {
	expectedMarketType string
	marketClient       marketv1.MarketServiceHTTPClient
	executionTarget    string
}

var _ market.CatalogSource = (*CatalogSource)(nil)

func NewCatalogSource(config CatalogSourceConfig) (*CatalogSource, error) {
	expectedMarketType := strings.ToLower(strings.TrimSpace(config.ExpectedMarketType))
	if expectedMarketType != "domestic" && expectedMarketType != "overseas" {
		return nil, errors.New("connector market type must be domestic or overseas")
	}
	client, err := marketclient.New(marketclient.Config{
		BaseURL:        config.BaseURL,
		HTTPClient:     config.HTTPClient,
		PrepareRequest: marketclient.PrepareRequestFunc(config.AuthorizeRequest),
	})
	if err != nil {
		return nil, fmt.Errorf("configure connector market client: %w", err)
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
	return &CatalogSource{expectedMarketType: expectedMarketType, marketClient: client, executionTarget: executionTarget}, nil
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
	payload, err := source.marketClient.ListMarketCategories(ctx, &marketv1.ListMarketCategoriesRequest{ItemType: "connector"})
	if err != nil {
		return nil, fmt.Errorf("request connector market catalog: %w", err)
	}
	if payload.GetMarketType() != source.expectedMarketType {
		return nil, errors.New("connector market type does not match configured market")
	}
	categories := make([]market.CatalogCategory, 0, len(payload.GetCategories()))
	seen := make(map[string]struct{}, len(payload.GetCategories()))
	for _, category := range payload.GetCategories() {
		if category == nil || strings.TrimSpace(category.GetCategoryId()) == "" ||
			(category.GetKind() != "category" && category.GetKind() != "featured") || category.GetItemCount() < 0 ||
			!categoryHasDisplayName(category) {
			return nil, errors.New("connector market category is invalid")
		}
		if _, exists := seen[category.GetCategoryId()]; exists {
			return nil, errors.New("connector market category is duplicated")
		}
		seen[category.GetCategoryId()] = struct{}{}
		categories = append(categories, market.CatalogCategory{
			CategoryID: category.GetCategoryId(), Kind: category.GetKind(), SortOrder: category.GetSortOrder(), ItemCount: category.GetItemCount(),
			DisplayNameZH: category.GetDisplayNameZh(), DisplayNameEN: category.GetDisplayNameEn(),
		})
	}
	return categories, nil
}

func (source *CatalogSource) ListPage(ctx context.Context, input market.CatalogSourcePageQuery) (market.CatalogSourcePage, error) {
	payload, err := source.marketClient.ListMarketItems(ctx, &marketv1.ListMarketItemsRequest{
		ItemType: "connector", SectionId: strings.TrimSpace(input.SectionID), PageSize: int32(input.PageSize), PageToken: strings.TrimSpace(input.PageToken),
	})
	if err != nil {
		return market.CatalogSourcePage{}, fmt.Errorf("request connector market catalog: %w", err)
	}
	if payload.GetMarketType() != source.expectedMarketType {
		return market.CatalogSourcePage{}, errors.New("connector market type does not match configured market")
	}
	entries := make([]market.CatalogEntry, 0, len(payload.GetItems()))
	for _, item := range payload.GetItems() {
		release, err := source.mapItem(item)
		if err != nil {
			return market.CatalogSourcePage{}, err
		}
		if strings.TrimSpace(item.GetCategoryId()) == "" {
			return market.CatalogSourcePage{}, errors.New("connector market item category is missing")
		}
		entries = append(entries, market.CatalogEntry{CategoryID: item.GetCategoryId(), Featured: item.GetFeatured(), Release: release})
	}
	return market.CatalogSourcePage{SectionID: strings.TrimSpace(input.SectionID), Entries: entries, NextPageToken: payload.GetNextPageToken()}, nil
}

func (source *CatalogSource) mapItem(item *marketv1.PublicMarketItem) (market.Release, error) {
	if item == nil || item.GetItemType() != "connector" || item.GetItemKey() == "" || item.GetVersion() == "" || item.GetArtifact() == nil || !safeArtifactKey(item.GetArtifact().GetKey()) || item.GetManifest() == nil {
		return market.Release{}, errors.New("connector market item identity is incomplete")
	}
	manifestBytes, err := json.Marshal(item.GetManifest().AsMap())
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
	if connectorManifest.ItemType != "connector" || connectorManifest.ItemKey != item.GetItemKey() || connectorManifest.Version != item.GetVersion() {
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
	releaseDigest := sha256.Sum256([]byte(item.GetItemKey() + "\x00" + item.GetVersion() + "\x00" + item.GetArtifact().GetSha256()))
	// The server's v2 envelope is the generic, market-neutral publication
	// contract. V3 selects one target first. Both project into the stable host
	// manifest contract; these schema versions describe different boundaries.
	manifest := market.Manifest{SchemaVersion: "1", DisplayName: connectorManifest.Display.Name, IconURL: connectorManifest.Display.IconURL,
		Description: connectorManifest.Display.Description, AgentRouting: connectorManifest.Payload.AgentRouting,
		Permissions:          connectorManifest.Payload.Permissions,
		RequiredCapabilities: connectorManifest.Payload.RequiredCapabilities,
		Implementation:       implementation, AuthorizationKind: connectorManifest.Payload.Authorization.Kind,
		AuthorizationInteraction: authorizationInteraction,
		Compatibility:            connectorManifest.Payload.Compatibility}
	release := market.Release{SchemaVersion: "1", ReleaseID: item.GetItemKey() + "@" + item.GetVersion(),
		ConnectorKey: item.GetItemKey(), Version: item.GetVersion(),
		ReleaseDigest: hex.EncodeToString(releaseDigest[:]), ManifestDigest: connectorManifest.Payload.PackageManifestSHA256,
		Manifest: manifest, Artifact: market.Artifact{Key: item.GetArtifact().GetKey(), SHA256: item.GetArtifact().GetSha256(),
			SizeBytes: item.GetArtifact().GetSizeBytes(), MediaType: artifactMediaType(item.GetArtifact().GetKey())},
		PublishedAt: time.UnixMilli(item.GetPublishedAtMs()).UTC(), Status: market.ReleaseStatusAvailable}
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
	case "3":
		if payload.Implementation != nil || len(payload.TargetImplementations) == 0 {
			return market.Implementation{}, errors.New("connector v3 manifest must provide targetImplementations")
		}
		return market.ResolveTargetImplementation(source.executionTarget, payload.TargetImplementations)
	default:
		return market.Implementation{}, fmt.Errorf("connector manifest schemaVersion %q is unsupported", manifest.SchemaVersion)
	}
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

func safeArtifactKey(key string) bool {
	cleaned := path.Clean(strings.TrimSpace(key))
	return cleaned != "." && cleaned != ".." && cleaned == key && !path.IsAbs(cleaned) && !strings.HasPrefix(cleaned, "../") && !strings.Contains(cleaned, "\\")
}

func categoryHasDisplayName(category *marketv1.MarketCategory) bool {
	if strings.TrimSpace(category.GetDisplayNameZh()) != "" || strings.TrimSpace(category.GetDisplayNameEn()) != "" {
		return true
	}
	// Compatibility window for the released category response that preceded
	// display names. New dynamic IDs must always carry a server-owned name.
	switch category.GetCategoryId() {
	case "featured", "productivity", "development", "other":
		return true
	default:
		return false
	}
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
