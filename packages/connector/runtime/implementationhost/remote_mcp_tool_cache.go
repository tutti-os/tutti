package implementationhost

import (
	"strings"
	"sync"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

// remoteMCPToolCache keeps successful route-activation tools/list results in
// process memory. It is not Agent-visible truth and has no TTL; identity
// changes miss, and the Host drops the table on Close.
type remoteMCPToolCache struct {
	mu    sync.RWMutex
	tools map[remoteMCPToolCacheKey][]mcpTool
}

type remoteMCPToolCacheKey struct {
	accountID         string
	connectorKey      string
	releaseDigest     string
	connectionID      string
	connectionVersion uint64
	serverRevision    uint64
}

func newRemoteMCPToolCache() *remoteMCPToolCache {
	return &remoteMCPToolCache{tools: make(map[remoteMCPToolCacheKey][]mcpTool)}
}

func remoteMCPToolCacheKeyFrom(request market.RuntimeReconcileRequest) remoteMCPToolCacheKey {
	return remoteMCPToolCacheKey{
		accountID:         strings.TrimSpace(request.Scope.AccountID),
		connectorKey:      strings.TrimSpace(request.Connector.Key),
		releaseDigest:     strings.TrimSpace(request.Connector.Release.ReleaseDigest),
		connectionID:      strings.TrimSpace(request.ConnectionID),
		connectionVersion: request.ConnectionVersion,
		serverRevision:    request.ServerRevision,
	}
}

func (key remoteMCPToolCacheKey) complete() bool {
	return key.accountID != "" && key.connectorKey != "" && key.releaseDigest != "" && key.connectionID != ""
}

func (cache *remoteMCPToolCache) lookup(key remoteMCPToolCacheKey) ([]mcpTool, bool) {
	if cache == nil || !key.complete() {
		return nil, false
	}
	cache.mu.RLock()
	defer cache.mu.RUnlock()
	tools, ok := cache.tools[key]
	if !ok {
		return nil, false
	}
	return cloneMCPTools(tools), true
}

func (cache *remoteMCPToolCache) store(key remoteMCPToolCacheKey, tools []mcpTool) {
	if cache == nil || !key.complete() || len(tools) == 0 {
		return
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	cache.tools[key] = cloneMCPTools(tools)
}

func (cache *remoteMCPToolCache) clear() {
	if cache == nil {
		return
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	cache.tools = make(map[remoteMCPToolCacheKey][]mcpTool)
}

func cloneMCPTools(tools []mcpTool) []mcpTool {
	cloned := make([]mcpTool, len(tools))
	for index, tool := range tools {
		cloned[index] = mcpTool{
			Name:        tool.Name,
			Description: tool.Description,
			InputSchema: cloneJSONMap(tool.InputSchema),
		}
	}
	return cloned
}
