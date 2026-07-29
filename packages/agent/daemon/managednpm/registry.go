package managednpm

import (
	"context"
	"net/url"
	"sort"
	"strings"
	"time"
)

const (
	RegistryOverrideEnv = "TUTTI_AGENT_NPM_REGISTRY"
	OfficialRegistryURL = "https://registry.npmjs.org"
	HuaweiRegistryURL   = "https://repo.huaweicloud.com/repository/npm/"
	TencentRegistryURL  = "https://mirrors.cloud.tencent.com/npm/"
	// Registry probes can perform two cold npm metadata requests (the root
	// package and its platform package) inside a newly started VM. Keep the
	// candidates concurrent, but allow enough time for first DNS/TLS/cache use.
	DefaultProbeTimeout = 20 * time.Second
	MinimumRankDelta    = 25 * time.Millisecond
)

type Registry struct {
	ID     string
	URL    string
	Pinned bool
}

func ResolveOptionalPlatformPackage(packageName string, optionalDependencies map[string]string, platformOS string, platformArch string) (string, string, bool) {
	packageName = strings.TrimSpace(packageName)
	platformOS, platformArch, platformOK := NPMPlatform(platformOS, platformArch)
	if packageName == "" || !platformOK {
		return "", "", false
	}
	separator := strings.LastIndex(packageName, "/")
	prefix, name := "", packageName
	if separator >= 0 {
		prefix, name = packageName[:separator+1], packageName[separator+1:]
	}
	dependencyName := prefix + name + "-" + platformOS + "-" + platformArch
	spec := strings.TrimSpace(optionalDependencies[dependencyName])
	if spec == "" {
		return "", "", false
	}
	if !strings.HasPrefix(spec, "npm:") {
		return dependencyName, spec, true
	}
	aliased := strings.TrimPrefix(spec, "npm:")
	versionSeparator := strings.LastIndex(aliased, "@")
	if versionSeparator <= 0 || versionSeparator == len(aliased)-1 {
		return "", "", false
	}
	return aliased[:versionSeparator], aliased[versionSeparator+1:], true
}

// NPMPlatform maps Go target names to the operating-system and architecture
// suffixes used by npm platform packages. It also accepts already-canonical
// npm names so hosts do not need their own platform mapping tables.
func NPMPlatform(platformOS string, platformArch string) (string, string, bool) {
	switch strings.TrimSpace(platformOS) {
	case "linux":
		platformOS = "linux"
	case "darwin":
		platformOS = "darwin"
	case "windows", "win32":
		platformOS = "win32"
	default:
		return "", "", false
	}
	switch strings.TrimSpace(platformArch) {
	case "amd64", "x64":
		platformArch = "x64"
	case "arm64":
		platformArch = "arm64"
	default:
		return "", "", false
	}
	return platformOS, platformArch, true
}

type RegistryProbeRequest struct {
	Registry        Registry
	PackageName     string
	Version         string
	IncludeOptional bool
	OperatingSystem string
	Architecture    string
}

type RegistryProbeResult struct {
	Reachable bool
	Complete  bool
	Duration  time.Duration
}

type RegistryProber interface {
	ProbeRegistry(context.Context, RegistryProbeRequest) RegistryProbeResult
}

type RankedRegistry struct {
	Registry Registry
	Probe    RegistryProbeResult
}

func DefaultRegistries(override string) []Registry {
	if value := strings.TrimSpace(override); value != "" {
		return []Registry{{ID: "override", URL: value, Pinned: true}}
	}
	return []Registry{
		{ID: "npm", URL: OfficialRegistryURL},
		{ID: "huawei", URL: HuaweiRegistryURL},
		{ID: "tencent", URL: TencentRegistryURL},
	}
}

func RankRegistries(ctx context.Context, descriptor Descriptor, registries []Registry, platformOS string, platformArch string, prober RegistryProber) []RankedRegistry {
	if len(registries) == 0 || prober == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	type indexedResult struct {
		index int
		RankedRegistry
	}
	results := make(chan indexedResult, len(registries))
	for index, registry := range registries {
		go func(index int, registry Registry) {
			probeCtx, cancel := context.WithTimeout(ctx, DefaultProbeTimeout)
			defer cancel()
			startedAt := time.Now()
			probe := prober.ProbeRegistry(probeCtx, RegistryProbeRequest{
				Registry: registry, PackageName: descriptor.PackageName,
				Version: descriptor.RecommendedVersion, IncludeOptional: descriptor.IncludeOptional,
				OperatingSystem: platformOS, Architecture: platformArch,
			})
			if probe.Duration <= 0 {
				probe.Duration = time.Since(startedAt)
			}
			results <- indexedResult{index: index, RankedRegistry: RankedRegistry{Registry: registry, Probe: probe}}
		}(index, registry)
	}
	probed := make([]indexedResult, 0, len(registries))
	for range registries {
		probed = append(probed, <-results)
	}
	fastestEligible := time.Duration(1<<63 - 1)
	for _, candidate := range probed {
		if candidate.Probe.Reachable && candidate.Probe.Complete && candidate.Probe.Duration < fastestEligible {
			fastestEligible = candidate.Probe.Duration
		}
	}
	sort.SliceStable(probed, func(i, j int) bool {
		left, right := probed[i], probed[j]
		leftEligible := left.Probe.Reachable && left.Probe.Complete
		rightEligible := right.Probe.Reachable && right.Probe.Complete
		if leftEligible != rightEligible {
			return leftEligible
		}
		if leftEligible {
			leftInFastBand := left.Probe.Duration <= fastestEligible+MinimumRankDelta
			rightInFastBand := right.Probe.Duration <= fastestEligible+MinimumRankDelta
			if leftInFastBand != rightInFastBand {
				return leftInFastBand
			}
			if !leftInFastBand && left.Probe.Duration != right.Probe.Duration {
				return left.Probe.Duration < right.Probe.Duration
			}
		}
		return left.index < right.index
	})
	ranked := make([]RankedRegistry, len(probed))
	for index := range probed {
		ranked[index] = probed[index].RankedRegistry
	}
	return ranked
}

func PackageEndpoint(registryURL string, packageName string, version string) string {
	registryURL = strings.TrimRight(strings.TrimSpace(registryURL), "/")
	packageName = strings.TrimSpace(packageName)
	if registryURL == "" || packageName == "" {
		return registryURL
	}
	escapedPackage := strings.ReplaceAll(packageName, "/", "%2f")
	endpoint := registryURL + "/" + escapedPackage
	if value := strings.TrimSpace(version); value != "" {
		endpoint += "/" + url.PathEscape(value)
	}
	return endpoint
}

func DisplayRegistryHost(registryURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(registryURL))
	if err != nil || parsed.Hostname() == "" {
		return "invalid-registry"
	}
	return parsed.Hostname()
}
