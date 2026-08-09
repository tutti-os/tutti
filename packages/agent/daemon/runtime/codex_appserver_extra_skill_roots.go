package agentruntime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

const (
	tuttiAgentExtraSkillRootsEnv    = "TUTTI_AGENT_EXTRA_SKILL_ROOTS_JSON"
	tuttiAgentStableSystemSkillsEnv = "TUTTI_AGENT_STABLE_SYSTEM_SKILLS_ROOT"
	tuttiAgentHomeEnv               = "TUTTI_AGENT_HOME"
	tuttiAgentExtraSkillRootsLimit  = 32
)

func tuttiAgentStableSystemSkillsRoot(strategy providerregistry.AppServerSkillRootsStrategy, env []string) (string, error) {
	if strategy != providerregistry.AppServerSkillRootsStrategyTuttiStable {
		return "", nil
	}
	value, found := lastEnvironmentValue(env, tuttiAgentStableSystemSkillsEnv)
	if !found {
		return "", nil
	}
	root := filepath.Clean(strings.TrimSpace(value))
	if root == "." || !filepath.IsAbs(root) {
		return "", fmt.Errorf("tutti-agent stable system skill root must be absolute")
	}
	return root, nil
}

func tuttiAgentExtraSkillRoots(strategy providerregistry.AppServerSkillRootsStrategy, env []string) ([]string, error) {
	if strategy != providerregistry.AppServerSkillRootsStrategyTuttiStable {
		return nil, nil
	}
	value, found := lastEnvironmentValue(env, tuttiAgentExtraSkillRootsEnv)
	if !found {
		return nil, nil
	}
	var roots []string
	if err := json.Unmarshal([]byte(value), &roots); err != nil {
		return nil, fmt.Errorf("decode tutti-agent extra skill roots: %w", err)
	}
	if len(roots) == 0 {
		return nil, fmt.Errorf("tutti-agent extra skill roots must not be empty")
	}
	if len(roots) > tuttiAgentExtraSkillRootsLimit {
		return nil, fmt.Errorf("tutti-agent extra skill roots exceed limit")
	}
	cleaned := make([]string, 0, len(roots))
	seen := make(map[string]struct{}, len(roots))
	for _, root := range roots {
		root = filepath.Clean(strings.TrimSpace(root))
		if root == "." || !filepath.IsAbs(root) {
			return nil, fmt.Errorf("tutti-agent extra skill root must be absolute")
		}
		if _, exists := seen[root]; exists {
			continue
		}
		seen[root] = struct{}{}
		cleaned = append(cleaned, root)
	}
	return cleaned, nil
}

func lastEnvironmentValue(env []string, key string) (string, bool) {
	prefix := key + "="
	value := ""
	found := false
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			value = strings.TrimPrefix(entry, prefix)
			found = true
		}
	}
	return value, found
}

func withoutEnvironmentKey(env []string, key string) []string {
	prefix := key + "="
	filtered := make([]string, 0, len(env))
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			continue
		}
		filtered = append(filtered, entry)
	}
	return filtered
}

func extraSkillRootsFingerprint(roots []string) string {
	digest := sha256.Sum256([]byte(strings.Join(roots, "\x00")))
	return hex.EncodeToString(digest[:6])
}

func (a *CodexAppServerAdapter) configureExtraSkillRoots(
	ctx context.Context,
	client *codexAppServerClient,
	session Session,
	roots []string,
	trace *codexAppServerStartupTrace,
) error {
	if len(roots) == 0 {
		return nil
	}
	trace.Log("skills.extra_roots.set.begin", map[string]any{
		"root_count":  len(roots),
		"fingerprint": extraSkillRootsFingerprint(roots),
	})
	_, err := trace.TypedCall(
		acpStartCallTimeout,
		appServerMethodSkillsExtraRootsSet,
		func() (json.RawMessage, error) {
			return client.SkillsExtraRootsSet(
				ctx,
				acpStartCallTimeout,
				roots,
				func(ctx context.Context, message acpMessage) error {
					trace.LogMessage(message.Method, len(message.ID) > 0, len(message.Params))
					_, err := a.handleAppServerMessage(
						ctx,
						client,
						session,
						"",
						message,
						nil,
						nil,
						nil,
					)
					return err
				},
			)
		},
	)
	if err != nil {
		return fmt.Errorf("configure tutti-agent extra skill roots: %w", err)
	}
	trace.Log("skills.extra_roots.set.succeeded", map[string]any{
		"root_count":  len(roots),
		"fingerprint": extraSkillRootsFingerprint(roots),
	})
	return nil
}
