package commerce

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	defaultRequestTimeout = 5 * time.Second
	defaultBodyLimit      = int64(1 << 20)
)

type Config struct {
	BaseURL            string
	HTTPClient         *http.Client
	Authorizer         RequestAuthorizer
	RewardReceiptStore RewardReceiptStore
	RequestTimeout     time.Duration
	BodyLimit          int64
	Now                func() time.Time
}

type client struct {
	baseURL        *url.URL
	httpClient     *http.Client
	authorizer     RequestAuthorizer
	requestTimeout time.Duration
	bodyLimit      int64
}

func newClient(config Config) (*client, error) {
	baseURL, err := parseBaseURL(config.BaseURL)
	if err != nil {
		return nil, err
	}
	if config.Authorizer == nil {
		return nil, ErrRequestAuthorizerRequired
	}
	httpClient := config.HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	requestTimeout := config.RequestTimeout
	if requestTimeout <= 0 {
		requestTimeout = defaultRequestTimeout
	}
	bodyLimit := config.BodyLimit
	if bodyLimit <= 0 {
		bodyLimit = defaultBodyLimit
	}
	return &client{
		baseURL:        baseURL,
		httpClient:     httpClient,
		authorizer:     config.Authorizer,
		requestTimeout: requestTimeout,
		bodyLimit:      bodyLimit,
	}, nil
}

func parseBaseURL(value string) (*url.URL, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, ErrBaseURLRequired
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return nil, err
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("commerce base URL must use http or https")
	}
	if strings.TrimSpace(parsed.Host) == "" {
		return nil, errors.New("commerce base URL host is required")
	}
	return parsed, nil
}

func (c *client) userInfo(ctx context.Context) (map[string]any, error) {
	var output map[string]any
	err := c.json(ctx, http.MethodGet, "/v1/user-info", nil, &output)
	return output, err
}

func (c *client) creditsOverview(ctx context.Context) (map[string]any, error) {
	var output map[string]any
	err := c.json(ctx, http.MethodGet, "/v1/credits/overview", nil, &output)
	return output, err
}

func (c *client) loginClaim(ctx context.Context) (loginClaimResponse, error) {
	var output loginClaimResponse
	err := c.json(ctx, http.MethodPost, "/v1/credits/login-claim", bytes.NewReader([]byte(`{}`)), &output)
	return output, err
}

func (c *client) json(
	ctx context.Context,
	method string,
	path string,
	body io.Reader,
	output any,
) error {
	requestContext, cancel := context.WithTimeout(ctx, c.requestTimeout)
	defer cancel()

	request, err := http.NewRequestWithContext(
		requestContext,
		method,
		c.resolve(path),
		body,
	)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if err := c.authorizer.Authorize(request); err != nil {
		return err
	}

	response, err := c.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, c.bodyLimit))
		return &HTTPError{StatusCode: response.StatusCode}
	}
	if output == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, c.bodyLimit))
		return nil
	}

	decoder := json.NewDecoder(io.LimitReader(response.Body, c.bodyLimit))
	decoder.UseNumber()
	if err := decoder.Decode(output); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		return err
	}
	return nil
}

func (c *client) resolve(path string) string {
	base := *c.baseURL
	base.Path = strings.TrimRight(base.Path, "/") + "/" + strings.TrimLeft(path, "/")
	base.RawPath = ""
	base.RawQuery = ""
	base.Fragment = ""
	return base.String()
}
