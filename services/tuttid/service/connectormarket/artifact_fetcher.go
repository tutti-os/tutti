package connectormarket

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/httpx"
	marketartifact "github.com/tutti-os/tutti/packages/connector/market/artifact"
)

type DirectArtifactFetcherConfig struct {
	BaseURL    string
	HTTPClient *http.Client
}

// DirectArtifactFetcher downloads the immutable artifact named by the market
// release. Downloading is not a workspace-authorized operation; integrity and
// size are enforced by artifact.Preparer before the bytes can be installed.
type DirectArtifactFetcher struct {
	baseURL    *url.URL
	httpClient *http.Client
}

var _ marketartifact.Fetcher = (*DirectArtifactFetcher)(nil)

func NewDirectArtifactFetcher(config DirectArtifactFetcherConfig) (*DirectArtifactFetcher, error) {
	baseURL, err := url.Parse(strings.TrimSpace(config.BaseURL))
	if err != nil || baseURL.Scheme == "" || baseURL.Host == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" {
		return nil, errors.New("connector artifact base URL is invalid")
	}
	if baseURL.Scheme != "https" && (baseURL.Scheme != "http" || !isLoopbackHost(baseURL.Hostname())) {
		return nil, errors.New("connector artifact base URL must use https (http is allowed only for loopback tests)")
	}
	baseURL.Path = strings.TrimSuffix(baseURL.Path, "/") + "/"

	client := config.HTTPClient
	if client == nil {
		client = httpx.NewClient(5 * time.Minute)
	}
	clientCopy := *client
	configuredRedirectCheck := client.CheckRedirect
	clientCopy.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if len(via) >= 3 || !sameOrigin(request.URL, baseURL) {
			return errors.New("connector artifact redirect leaves the configured origin")
		}
		if configuredRedirectCheck != nil {
			return configuredRedirectCheck(request, via)
		}
		return nil
	}
	return &DirectArtifactFetcher{baseURL: baseURL, httpClient: &clientCopy}, nil
}

func (fetcher *DirectArtifactFetcher) Fetch(ctx context.Context, request marketartifact.FetchRequest) (marketartifact.FetchResponse, error) {
	artifactKey := strings.TrimSpace(request.Release.Artifact.Key)
	if !safeArtifactKey(artifactKey) {
		return marketartifact.FetchResponse{}, errors.New("connector artifact key is invalid")
	}
	endpoint := fetcher.baseURL.ResolveReference(&url.URL{Path: artifactKey})
	if !sameOrigin(endpoint, fetcher.baseURL) || !strings.HasPrefix(endpoint.EscapedPath(), fetcher.baseURL.EscapedPath()) {
		return marketartifact.FetchResponse{}, errors.New("connector artifact URL leaves the configured base path")
	}
	downloadRequest, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return marketartifact.FetchResponse{}, err
	}
	downloadResponse, err := fetcher.httpClient.Do(downloadRequest)
	if err != nil {
		return marketartifact.FetchResponse{}, fmt.Errorf("download connector artifact: %w", err)
	}
	if downloadResponse.StatusCode != http.StatusOK {
		defer downloadResponse.Body.Close()
		message, _ := io.ReadAll(io.LimitReader(downloadResponse.Body, 4<<10))
		return marketartifact.FetchResponse{}, fmt.Errorf("download connector artifact: status %d: %s", downloadResponse.StatusCode, strings.TrimSpace(string(message)))
	}
	return marketartifact.FetchResponse{
		Body:          downloadResponse.Body,
		ContentLength: downloadResponse.ContentLength,
		MediaType:     downloadResponse.Header.Get("Content-Type"),
	}, nil
}

func sameOrigin(left, right *url.URL) bool {
	return left != nil && right != nil && strings.EqualFold(left.Scheme, right.Scheme) && strings.EqualFold(left.Host, right.Host)
}
