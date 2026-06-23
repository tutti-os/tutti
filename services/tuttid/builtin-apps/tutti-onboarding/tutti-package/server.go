package main

import (
	"encoding/json"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func main() {
	host := envValue("TUTTI_APP_HOST", "127.0.0.1")
	port := envValue("TUTTI_APP_PORT", "3003")
	packageDir := envValue("TUTTI_APP_PACKAGE_DIR", ".")
	publicDir := filepath.Join(packageDir, "dist")

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(response http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodGet && request.URL.Path == "/healthz" {
			response.WriteHeader(http.StatusNoContent)
			return
		}
		if request.Method != http.MethodGet && request.Method != http.MethodHead {
			writeJSON(response, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
			return
		}
		serveStatic(response, request, publicDir)
	})

	server := &http.Server{
		Addr:              host + ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Printf("tutti-onboarding listening on http://%s", server.Addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func envValue(key string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("content-type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	if err := json.NewEncoder(response).Encode(body); err != nil {
		log.Printf("write json response: %v", err)
	}
}

func serveStatic(response http.ResponseWriter, request *http.Request, publicDir string) {
	staticPath, ok := resolveStaticPath(publicDir, request.URL.Path)
	if !ok {
		writeJSON(response, http.StatusNotFound, map[string]string{"error": "Not Found"})
		return
	}
	if strings.HasPrefix(request.URL.Path, "/assets/") {
		response.Header().Set("cache-control", "public, max-age=31536000, immutable")
	} else {
		response.Header().Set("cache-control", "no-store")
	}
	if contentType := contentTypeForPath(staticPath); contentType != "" {
		response.Header().Set("content-type", contentType)
	}
	http.ServeFile(response, request, staticPath)
}

func resolveStaticPath(publicDir string, urlPath string) (string, bool) {
	requestedPath := urlPath
	if requestedPath == "/" {
		requestedPath = "/index.html"
	}
	cleaned := filepath.Clean("/" + requestedPath)
	relative := strings.TrimPrefix(cleaned, string(filepath.Separator))
	resolved := filepath.Join(publicDir, relative)
	if !pathInside(publicDir, resolved) {
		return "", false
	}
	if isFile(resolved) {
		return resolved, true
	}
	if filepath.Ext(requestedPath) == "" {
		indexPath := filepath.Join(publicDir, "index.html")
		if isFile(indexPath) {
			return indexPath, true
		}
	}
	return "", false
}

func pathInside(root string, candidate string) bool {
	rel, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	return rel == "." || (!strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != "..")
}

func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func contentTypeForPath(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".js":
		return "text/javascript; charset=utf-8"
	case ".json":
		return "application/json; charset=utf-8"
	}
	if contentType := mime.TypeByExtension(filepath.Ext(path)); contentType != "" {
		return contentType
	}
	if _, err := strconv.Atoi(filepath.Base(path)); err == nil {
		return "application/octet-stream"
	}
	return ""
}
