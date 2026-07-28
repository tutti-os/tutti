package modelgateway

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGatewayBoundsJSONFallbackForStreamingResponse(t *testing.T) {
	t.Parallel()

	const maxResponseBytes = 512
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(
			writer,
			fmt.Sprintf(
				`{"id":"chat-oversized","model":"model-a","choices":[{"index":0,"message":{"role":"assistant","content":%q},"finish_reason":"stop"}]}`,
				strings.Repeat("x", maxResponseBytes),
			),
		)
	}))
	defer upstream.Close()

	gateway := newTestGateway(t, Config{MaxRequestBytes: maxResponseBytes})
	endpoint := registerTestRoute(t, gateway, upstream.URL, "secret", "model-a", "workspace", "session")
	response := postResponses(t, endpoint, `{"model":"model-a","input":"hello","stream":true}`, nil)
	defer response.Body.Close()

	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf(
			"status = %d, want %d, body = %s",
			response.StatusCode,
			http.StatusBadGateway,
			readBody(t, response.Body),
		)
	}
	if body := readBody(t, response.Body); !strings.Contains(body, `"code":"upstream_error"`) {
		t.Fatalf("body = %s, want upstream_error", body)
	}
}
