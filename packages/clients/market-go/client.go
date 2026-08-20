// Package marketclient provides the generated, market-neutral TSH Market HTTP
// client boundary shared by Connector and future Skill consumers.
package marketclient

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	khttp "github.com/go-kratos/kratos/v2/transport/http"
	marketv1 "github.com/tutti-os/tutti/packages/clients/market-go/generated/sandbox/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

const (
	// MaxResponseBodyBytes bounds successful Market API responses before decode.
	MaxResponseBodyBytes = 8 << 20
	maxErrorBodyBytes    = 4 << 10
)

type PrepareRequestFunc func(*http.Request) error

type Config struct {
	BaseURL        string
	HTTPClient     *http.Client
	PrepareRequest PrepareRequestFunc
}

// New constructs the generated Market HTTP client while retaining the
// product-owned proxy transport, timeout, authentication, and gateway path.
func New(config Config) (marketv1.MarketServiceHTTPClient, error) {
	baseURL, err := normalizeBaseURL(config.BaseURL)
	if err != nil {
		return nil, err
	}
	if config.HTTPClient == nil {
		return nil, errors.New("market HTTP client is required")
	}
	roundTripper := config.HTTPClient.Transport
	if roundTripper == nil {
		roundTripper = http.DefaultTransport
	}
	httpClient := *config.HTTPClient
	httpClient.Transport = roundTripper
	httpClient.CheckRedirect = sameOriginRedirectPolicy(baseURL, config.HTTPClient.CheckRedirect)
	roundTripper = &marketRoundTripper{
		client:         &httpClient,
		basePath:       strings.TrimRight(baseURL.Path, "/"),
		prepareRequest: config.PrepareRequest,
	}
	endpoint := baseURL.Scheme + "://" + baseURL.Host
	transport, err := khttp.NewClient(
		context.Background(),
		khttp.WithEndpoint(endpoint),
		khttp.WithTransport(roundTripper),
		khttp.WithTimeout(config.HTTPClient.Timeout),
		khttp.WithResponseDecoder(decodeResponse),
		khttp.WithErrorDecoder(decodeError),
	)
	if err != nil {
		return nil, fmt.Errorf("create Market HTTP client: %w", err)
	}
	return marketv1.NewMarketServiceHTTPClient(transport), nil
}

func normalizeBaseURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("market base URL must be an absolute URL without credentials, query, or fragment")
	}
	if parsed.Scheme != "https" && (parsed.Scheme != "http" || !isLoopbackHost(parsed.Hostname())) {
		return nil, errors.New("market base URL must use https (http is allowed only for loopback tests)")
	}
	return parsed, nil
}

func isLoopbackHost(host string) bool {
	host = strings.Trim(strings.ToLower(host), "[]")
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

type marketRoundTripper struct {
	client         *http.Client
	basePath       string
	prepareRequest PrepareRequestFunc
}

func (transport *marketRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	cloned := request.Clone(request.Context())
	cloned.URL.Path = joinURLPath(transport.basePath, request.URL.Path)
	cloned.URL.RawPath = ""
	cloned.Header = request.Header.Clone()
	cloned.Header.Set("Accept", "application/json")
	if transport.prepareRequest != nil {
		if err := transport.prepareRequest(cloned); err != nil {
			return nil, err
		}
	}
	response, err := transport.client.Do(cloned)
	if err != nil {
		return nil, err
	}
	return response, nil
}

func sameOriginRedirectPolicy(baseURL *url.URL, hostPolicy func(*http.Request, []*http.Request) error) func(*http.Request, []*http.Request) error {
	return func(request *http.Request, via []*http.Request) error {
		if !strings.EqualFold(request.URL.Scheme, baseURL.Scheme) || !strings.EqualFold(request.URL.Host, baseURL.Host) {
			return errors.New("market redirect must remain on the configured origin")
		}
		if hostPolicy != nil {
			return hostPolicy(request, via)
		}
		if len(via) >= 10 {
			return errors.New("stopped after 10 redirects")
		}
		return nil
	}
}

func joinURLPath(prefix, suffix string) string {
	prefix = "/" + strings.Trim(prefix, "/")
	if prefix == "/" {
		prefix = ""
	}
	return prefix + "/" + strings.TrimLeft(suffix, "/")
}

func decodeResponse(_ context.Context, response *http.Response, target any) error {
	payload, err := readBounded(response.Body, MaxResponseBodyBytes)
	if err != nil {
		return fmt.Errorf("decode Market response: %w", err)
	}
	message, ok := target.(proto.Message)
	if !ok {
		return errors.New("decode Market response: target is not a protobuf message")
	}
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(payload, message); err != nil {
		return fmt.Errorf("decode Market response: %w", err)
	}
	return nil
}

func decodeError(_ context.Context, response *http.Response) error {
	if response.StatusCode >= http.StatusOK && response.StatusCode <= http.StatusMultipleChoices-1 {
		return nil
	}
	defer response.Body.Close()
	payload, err := readBounded(response.Body, maxErrorBodyBytes)
	if err != nil {
		return &HTTPError{StatusCode: response.StatusCode}
	}
	return &HTTPError{StatusCode: response.StatusCode, Body: strings.TrimSpace(string(payload))}
}

func readBounded(reader io.Reader, limit int64) ([]byte, error) {
	payload, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(payload)) > limit {
		return nil, errors.New("response exceeds size limit")
	}
	return payload, nil
}

type HTTPError struct {
	StatusCode int
	Body       string
}

func (err *HTTPError) Error() string {
	return fmt.Sprintf("Market request returned HTTP status %d", err.StatusCode)
}
