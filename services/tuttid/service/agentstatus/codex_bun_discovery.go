package agentstatus

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
)

const globalBinDiscoveryTimeout = 3 * time.Second
const bunGlobalBinOutputLimit = 4096

func (s Service) resolveCodexProviderSpec(ctx context.Context, spec ProviderSpec) ProviderSpec {
	if !isCodexStatusSpec(spec) || len(spec.AdapterCommand) == 0 {
		return spec
	}
	resolver := s.commandResolver()
	path := resolver.ResolveBinary(spec.BinaryNames, spec.AdapterEnv)
	if strings.TrimSpace(path) == "" {
		if binDir := s.discoverBunGlobalBinDir(ctx, resolver, spec.AdapterEnv); binDir != "" {
			effectivePath := envValueForKey(resolver.Env(spec.AdapterEnv), "PATH")
			spec.AdapterEnv = append(
				cloneStrings(spec.AdapterEnv),
				"PATH="+strings.Join(mergePathValues(binDir, effectivePath), string(os.PathListSeparator)),
			)
			path = resolver.ResolveBinary(spec.BinaryNames, spec.AdapterEnv)
			if path != "" {
				spec.resolvedCLIManager = "bun"
			}
		}
	}
	if strings.TrimSpace(path) == "" {
		return spec
	}
	command := cloneStrings(spec.AdapterCommand)
	command[0] = path
	spec.AdapterCommand = command
	if spec.resolvedCLIManager == "" && codexPathBelongsToBunInstall(path, resolver.Env(spec.AdapterEnv)) {
		spec.resolvedCLIManager = "bun"
	}
	return spec
}

func codexPathBelongsToBunInstall(path string, env []string) bool {
	if strings.Contains(filepath.ToSlash(path), "/.bun/") {
		return true
	}
	bunInstall := strings.TrimSpace(envValueForKey(env, "BUN_INSTALL"))
	if bunInstall == "" {
		return false
	}
	relative, err := filepath.Rel(filepath.Join(bunInstall, "bin"), path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator))
}

func (s Service) discoverBunGlobalBinDir(ctx context.Context, resolver runtimecmd.Resolver, overrides []string) string {
	bunPath := resolveBunBinary(resolver, overrides)
	if bunPath == "" {
		return ""
	}
	return s.BunGlobalBinCache.load(bunPath, func() string {
		release, acquired := s.DetectionCommands.acquire(ctx)
		if !acquired {
			return ""
		}
		defer release()

		if ctx == nil {
			ctx = context.Background()
		}
		commandCtx, cancel := context.WithTimeout(ctx, globalBinDiscoveryTimeout)
		defer cancel()
		command := exec.CommandContext(commandCtx, bunPath, "pm", "bin", "-g")
		command.Env = resolver.Env(overrides)
		output := &boundedCommandOutput{limit: bunGlobalBinOutputLimit}
		command.Stdout = output
		if err := command.Run(); err != nil {
			return ""
		}
		binDir := strings.TrimSpace(output.String())
		if !filepath.IsAbs(binDir) {
			return ""
		}
		return filepath.Clean(binDir)
	})
}

func resolveBunBinary(resolver runtimecmd.Resolver, overrides []string) string {
	env := resolver.Env(overrides)
	if bunInstall := strings.TrimSpace(envValueForKey(env, "BUN_INSTALL")); bunInstall != "" {
		bunPath := resolver.Resolve(bunBinaryName(), []string{
			"PATH=" + filepath.Join(bunInstall, "bin"),
		})
		if bunPath != bunBinaryName() {
			return bunPath
		}
	}
	return resolver.ResolveBinary([]string{bunBinaryName()}, overrides)
}

type boundedCommandOutput struct {
	value []byte
	limit int
}

func (w *boundedCommandOutput) Write(value []byte) (int, error) {
	written := len(value)
	remaining := w.limit - len(w.value)
	if remaining > 0 {
		if len(value) > remaining {
			value = value[:remaining]
		}
		w.value = append(w.value, value...)
	}
	return written, nil
}

func (w *boundedCommandOutput) String() string {
	return string(w.value)
}

func bunBinaryName() string {
	if runtime.GOOS == "windows" {
		return "bun.exe"
	}
	return "bun"
}

func envValueForKey(env []string, key string) string {
	for i := len(env) - 1; i >= 0; i-- {
		candidateKey, value, ok := strings.Cut(env[i], "=")
		if ok && strings.EqualFold(candidateKey, key) {
			return value
		}
	}
	return ""
}

func mergePathValues(prefix, existing string) []string {
	result := []string{}
	seen := map[string]struct{}{}
	for _, dir := range append([]string{prefix}, filepath.SplitList(existing)...) {
		dir = strings.TrimSpace(dir)
		if dir == "" {
			continue
		}
		key := filepath.Clean(dir)
		if runtime.GOOS == "windows" {
			key = strings.ToLower(key)
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, dir)
	}
	return result
}
