package server

import (
	"crypto/subtle"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	tuttiapi "github.com/tutti-os/tutti/services/tuttid/api"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

type Routes = tuttiapi.Routes

type ListenerSpec struct {
	AccessToken string
	Addr        string
}

func NewMux(routes Routes) *http.ServeMux {
	mux := http.NewServeMux()
	tuttiapi.RegisterRoutes(mux, routes)
	return mux
}

func NewHTTPServer(spec ListenerSpec, routes Routes) *http.Server {
	handler := tuttitypes.WithBearerTokenAuthFunc(
		spec.AccessToken,
		func(r *http.Request, token string) bool {
			return authorizeWorkspaceAppServerToken(r, token, spec.AccessToken)
		},
		NewMux(routes),
	)

	return &http.Server{
		Addr:    spec.Addr,
		Handler: tuttitypes.WithCORS(handler),
	}
}

func authorizeWorkspaceAppServerToken(r *http.Request, token string, accessToken string) bool {
	segments := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(segments) < 6 ||
		segments[0] != "v1" ||
		segments[1] != "workspaces" ||
		segments[3] != "apps" {
		return false
	}
	if !isWorkspaceAppServerTokenRoute(r.Method, segments) {
		return false
	}
	workspaceID, err := url.PathUnescape(segments[2])
	if err != nil {
		return false
	}
	appID, err := url.PathUnescape(segments[4])
	if err != nil {
		return false
	}
	expected := workspacebiz.AppServerToken(accessToken, workspaceID, appID)
	return expected != "" && subtle.ConstantTimeCompare([]byte(token), []byte(expected)) == 1
}

func isWorkspaceAppServerTokenRoute(method string, segments []string) bool {
	if len(segments) == 8 &&
		method == http.MethodPut &&
		segments[5] == "uploads" &&
		strings.TrimSpace(segments[6]) != "" &&
		segments[7] == "content" {
		return true
	}
	if (len(segments) != 7 && len(segments) != 8) ||
		segments[5] != "managed-model-grants" {
		return false
	}
	switch method {
	case http.MethodPost:
		return (len(segments) == 7 && segments[6] == "exchange") ||
			(len(segments) == 8 && segments[7] == "credentials")
	case http.MethodGet:
		return len(segments) == 8 && segments[7] == "models"
	case http.MethodDelete:
		return len(segments) == 7 && segments[6] != "exchange"
	default:
		return false
	}
}

func ListenerSpecFromEnv() (ListenerSpec, error) {
	defaults := tuttitypes.ResolveDefaultsFromEnv()
	accessToken := tuttitypes.EnvOrDefault("TUTTID_ACCESS_TOKEN", "")
	if accessToken == "" {
		return ListenerSpec{}, fmt.Errorf("TUTTID_ACCESS_TOKEN is required")
	}

	return ListenerSpec{
		AccessToken: accessToken,
		Addr:        defaults.Transport.TCPAddr,
	}, nil
}
