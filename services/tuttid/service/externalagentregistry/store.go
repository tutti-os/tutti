package externalagentregistry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode"

	"github.com/tutti-os/tutti/packages/agentactivity/daemon/httpx"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

const DefaultSourceURL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"
const defaultRefreshTTL = time.Hour
const maxRegistryBytes int64 = 2 * 1024 * 1024

var ErrUnavailable = errors.New("external agent registry unavailable")
var ErrAgentNotFound = errors.New("external agent registry agent not found")

type Store struct {
	SourceURL  string
	CacheRoot  string
	HTTPClient *http.Client
	Now        func() time.Time
	RefreshTTL time.Duration
}

type Agent struct {
	ID           string
	Name         string
	Version      string
	Description  string
	Distribution Distribution
}

type Distribution struct {
	Binary map[string]BinaryTarget
	NPM    *NPMDistribution
}

type BinaryTarget struct {
	Archive string
	Command string
	Args    []string
	SHA256  string
	Env     map[string]string
}

type NPMDistribution struct {
	Package string
	Args    []string
	Env     map[string]string
}

type registryIndex struct {
	Version string          `json:"version"`
	Agents  []registryAgent `json:"agents"`
}

type registryAgent struct {
	ID           string               `json:"id"`
	Name         string               `json:"name"`
	Version      string               `json:"version"`
	Description  string               `json:"description"`
	Distribution registryDistribution `json:"distribution"`
}

type registryDistribution struct {
	Binary map[string]registryBinaryTarget `json:"binary"`
	NPM    *registryNPMDistribution        `json:"npx"`
}

type registryBinaryTarget struct {
	Archive string            `json:"archive"`
	Command string            `json:"cmd"`
	Args    []string          `json:"args"`
	SHA256  string            `json:"sha256"`
	Env     map[string]string `json:"env"`
}

type registryNPMDistribution struct {
	Package string            `json:"package"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
}

func (s Store) Agent(ctx context.Context, id string) (Agent, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return Agent{}, fmt.Errorf("%w: empty agent id", ErrAgentNotFound)
	}
	agents, err := s.Agents(ctx)
	if err != nil {
		return Agent{}, err
	}
	for _, agent := range agents {
		if agent.ID == id {
			return agent, nil
		}
	}
	return Agent{}, fmt.Errorf("%w: %s", ErrAgentNotFound, id)
}

func (s Store) Agents(ctx context.Context) ([]Agent, error) {
	cachePath := s.CachePath()
	if s.cacheFresh(cachePath) {
		agents, err := readRegistryFile(cachePath)
		if err == nil {
			return agents, nil
		}
	}
	body, err := s.fetch(ctx)
	if err == nil {
		agents, parseErr := parseRegistry(body)
		if parseErr != nil {
			return nil, parseErr
		}
		if writeErr := os.MkdirAll(filepath.Dir(cachePath), 0o755); writeErr == nil {
			_ = os.WriteFile(cachePath, body, 0o644)
		}
		return agents, nil
	}
	agents, cacheErr := readRegistryFile(cachePath)
	if cacheErr == nil {
		return agents, nil
	}
	return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
}

func (s Store) CachePath() string {
	return filepath.Join(s.cacheRoot(), "cache", "registry.json")
}

func (s Store) PackagePrefix(agentID string) string {
	return filepath.Join(s.cacheRoot(), "packages", sanitizePathComponent(agentID))
}

func (s Store) BinaryInstallDir(agentID string) string {
	return filepath.Join(s.cacheRoot(), "binaries", sanitizePathComponent(agentID))
}

func (s Store) cacheRoot() string {
	if root := strings.TrimSpace(s.CacheRoot); root != "" {
		return filepath.Clean(root)
	}
	return filepath.Join(tuttitypes.DefaultStateDir(), "agent-providers", "external-agent-registry")
}

func (s Store) cacheFresh(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	ttl := s.RefreshTTL
	if ttl <= 0 {
		ttl = defaultRefreshTTL
	}
	return s.now().Sub(info.ModTime()) < ttl
}

func (s Store) fetch(ctx context.Context) ([]byte, error) {
	source := strings.TrimSpace(s.SourceURL)
	if source == "" {
		source = DefaultSourceURL
	}
	if !strings.HasPrefix(source, "http://") && !strings.HasPrefix(source, "https://") {
		return os.ReadFile(source)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return nil, fmt.Errorf("create external agent registry request: %w", err)
	}
	response, err := s.httpClient().Do(request)
	if err != nil {
		return nil, fmt.Errorf("download external agent registry: %w", err)
	}
	defer func() {
		_ = response.Body.Close()
	}()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("download external agent registry: unexpected status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxRegistryBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read external agent registry: %w", err)
	}
	if int64(len(body)) > maxRegistryBytes {
		return nil, fmt.Errorf("external agent registry exceeds maximum size")
	}
	return body, nil
}

func (s Store) httpClient() *http.Client {
	if s.HTTPClient != nil {
		return s.HTTPClient
	}
	return httpx.Default()
}

func (s Store) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func readRegistryFile(path string) ([]Agent, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return parseRegistry(body)
}

func parseRegistry(body []byte) ([]Agent, error) {
	var index registryIndex
	if err := json.Unmarshal(body, &index); err != nil {
		return nil, fmt.Errorf("parse external agent registry: %w", err)
	}
	if strings.TrimSpace(index.Version) == "" {
		return nil, fmt.Errorf("external agent registry version is required")
	}
	agents := make([]Agent, 0, len(index.Agents))
	for _, entry := range index.Agents {
		agent := Agent{
			ID:          strings.TrimSpace(entry.ID),
			Name:        strings.TrimSpace(entry.Name),
			Version:     strings.TrimSpace(entry.Version),
			Description: strings.TrimSpace(entry.Description),
			Distribution: Distribution{
				Binary: convertBinaryTargets(entry.Distribution.Binary),
				NPM:    convertNPMDistribution(entry.Distribution.NPM),
			},
		}
		if agent.ID == "" {
			return nil, fmt.Errorf("external agent registry contains an empty agent id")
		}
		agents = append(agents, agent)
	}
	return agents, nil
}

func convertBinaryTargets(targets map[string]registryBinaryTarget) map[string]BinaryTarget {
	if len(targets) == 0 {
		return nil
	}
	result := make(map[string]BinaryTarget, len(targets))
	for platform, target := range targets {
		result[strings.TrimSpace(platform)] = BinaryTarget{
			Archive: strings.TrimSpace(target.Archive),
			Command: strings.TrimSpace(target.Command),
			Args:    append([]string(nil), target.Args...),
			SHA256:  strings.TrimSpace(target.SHA256),
			Env:     cloneStringMap(target.Env),
		}
	}
	return result
}

func convertNPMDistribution(distribution *registryNPMDistribution) *NPMDistribution {
	if distribution == nil || strings.TrimSpace(distribution.Package) == "" {
		return nil
	}
	return &NPMDistribution{
		Package: strings.TrimSpace(distribution.Package),
		Args:    append([]string(nil), distribution.Args...),
		Env:     cloneStringMap(distribution.Env),
	}
}

func CurrentPlatformKey() string {
	return RegistryPlatformKey(runtime.GOOS, runtime.GOARCH)
}

func RegistryPlatformKey(goos string, goarch string) string {
	switch strings.TrimSpace(goarch) {
	case "arm64":
		goarch = "aarch64"
	case "amd64":
		goarch = "x86_64"
	}
	if strings.TrimSpace(goos) == "" || strings.TrimSpace(goarch) == "" {
		return ""
	}
	return strings.TrimSpace(goos) + "-" + strings.TrimSpace(goarch)
}

func GoPlatformKey(registryPlatform string) string {
	parts := strings.Split(strings.TrimSpace(registryPlatform), "-")
	if len(parts) != 2 {
		return strings.TrimSpace(registryPlatform)
	}
	arch := parts[1]
	switch arch {
	case "aarch64":
		arch = "arm64"
	case "x86_64":
		arch = "amd64"
	}
	return parts[0] + "-" + arch
}

func sanitizePathComponent(value string) string {
	var builder strings.Builder
	for _, char := range strings.TrimSpace(value) {
		switch {
		case unicode.IsLetter(char), unicode.IsDigit(char), char == '-', char == '_', char == '.':
			builder.WriteRune(char)
		default:
			builder.WriteByte('-')
		}
	}
	if builder.Len() == 0 {
		return "agent"
	}
	return builder.String()
}

func cloneStringMap(input map[string]string) map[string]string {
	if len(input) == 0 {
		return nil
	}
	output := make(map[string]string, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}
