package managednpm

import (
	"context"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestDescriptorValidationAndVersionDecision(t *testing.T) {
	descriptor := Descriptor{PackageName: "@tutti-os/tutti-agent", BinaryName: "tutti-agent", MinimumVersion: "0.0.4", RecommendedVersion: "0.0.4", IncludeOptional: true}
	if err := descriptor.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	want := map[string]VersionDecision{
		"":                  VersionDecisionInstallMissing,
		"unknown":           VersionDecisionInstallUnknown,
		"tutti-agent 0.0.3": VersionDecisionInstallBelowFloor,
		"tutti-agent 0.0.4": VersionDecisionReady,
		"tutti-agent 1.0.0": VersionDecisionReady,
	}
	for output, expected := range want {
		if got := DecideVersion(output, descriptor.MinimumVersion); got != expected {
			t.Fatalf("DecideVersion(%q) = %q, want %q", output, got, expected)
		}
	}
	for _, output := range []string{"tutti-agent 0.0.4-beta.1", "tutti-agent 0.0.4.1"} {
		if got := DecideVersion(output, descriptor.MinimumVersion); got != VersionDecisionInstallUnknown {
			t.Fatalf("DecideVersion(%q) = %q, want %q", output, got, VersionDecisionInstallUnknown)
		}
	}
	descriptor.PackageName = " @tutti-os/tutti-agent"
	if err := descriptor.Validate(); err == nil {
		t.Fatal("Validate() error = nil, want non-canonical package rejection")
	}
	descriptor.PackageName = "@tutti-os/tutti-agent"
	descriptor.RecommendedVersion = "0.0.3"
	if err := descriptor.Validate(); err == nil {
		t.Fatal("Validate() error = nil, want recommended-below-floor rejection")
	}
}

func TestRankRegistriesRequiresCompletenessAndAvoidsTimingNoise(t *testing.T) {
	descriptor := Descriptor{PackageName: "@tutti-os/tutti-agent", BinaryName: "tutti-agent", MinimumVersion: "0.0.4", RecommendedVersion: "0.0.4", IncludeOptional: true}
	prober := fakeExecutor{registryProbes: map[string]RegistryProbeResult{
		"official": {Reachable: true, Complete: true, Duration: 90 * time.Millisecond},
		"fast-bad": {Reachable: true, Complete: false, Duration: 5 * time.Millisecond},
		"mirror":   {Reachable: true, Complete: true, Duration: 20 * time.Millisecond},
	}}
	registries := []Registry{{ID: "official"}, {ID: "fast-bad"}, {ID: "mirror"}}
	ranked := RankRegistries(context.Background(), descriptor, registries, "linux", "arm64", &prober)
	got := []string{ranked[0].Registry.ID, ranked[1].Registry.ID, ranked[2].Registry.ID}
	if want := []string{"mirror", "official", "fast-bad"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("RankRegistries() = %#v, want %#v", got, want)
	}
}

func TestRankRegistriesUsesTransitiveFastBand(t *testing.T) {
	descriptor := testDescriptor()
	prober := fakeExecutor{registryProbes: map[string]RegistryProbeResult{
		"slow": {Reachable: true, Complete: true, Duration: 40 * time.Millisecond},
		"near": {Reachable: true, Complete: true, Duration: 20 * time.Millisecond},
		"fast": {Reachable: true, Complete: true, Duration: 1 * time.Millisecond},
	}}
	ranked := RankRegistries(context.Background(), descriptor, []Registry{{ID: "slow"}, {ID: "near"}, {ID: "fast"}}, "linux", "arm64", &prober)
	got := []string{ranked[0].Registry.ID, ranked[1].Registry.ID, ranked[2].Registry.ID}
	if want := []string{"near", "fast", "slow"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("RankRegistries() = %#v, want %#v", got, want)
	}
}

func TestResolveOptionalPlatformPackageSupportsNPMAlias(t *testing.T) {
	targets := []struct {
		goOS, goArch   string
		npmOS, npmArch string
	}{
		{goOS: "linux", goArch: "amd64", npmOS: "linux", npmArch: "x64"},
		{goOS: "linux", goArch: "arm64", npmOS: "linux", npmArch: "arm64"},
		{goOS: "darwin", goArch: "amd64", npmOS: "darwin", npmArch: "x64"},
		{goOS: "darwin", goArch: "arm64", npmOS: "darwin", npmArch: "arm64"},
		{goOS: "windows", goArch: "amd64", npmOS: "win32", npmArch: "x64"},
		{goOS: "windows", goArch: "arm64", npmOS: "win32", npmArch: "arm64"},
	}
	for _, target := range targets {
		t.Run(target.goOS+"-"+target.goArch, func(t *testing.T) {
			alias := "@tutti-os/tutti-agent-" + target.npmOS + "-" + target.npmArch
			version := "0.0.5-" + target.npmOS + "-" + target.npmArch
			name, gotVersion, ok := ResolveOptionalPlatformPackage(
				"@tutti-os/tutti-agent",
				map[string]string{alias: "npm:@tutti-os/tutti-agent@" + version},
				target.goOS,
				target.goArch,
			)
			if !ok || name != "@tutti-os/tutti-agent" || gotVersion != version {
				t.Fatalf("ResolveOptionalPlatformPackage() = %q, %q, %v", name, gotVersion, ok)
			}
		})
	}
	if _, _, ok := ResolveOptionalPlatformPackage("@tutti-os/tutti-agent", nil, "freebsd", "amd64"); ok {
		t.Fatal("ResolveOptionalPlatformPackage() accepted unsupported target")
	}
}

func testDescriptor() Descriptor {
	return Descriptor{PackageName: "@tutti-os/tutti-agent", BinaryName: "tutti-agent", MinimumVersion: "0.0.4", RecommendedVersion: "0.0.4", IncludeOptional: true}
}

type fakeExecutor struct {
	registryProbes     map[string]RegistryProbeResult
	registryProbeMu    sync.Mutex
	registryProbeCalls int
}

func (f *fakeExecutor) ProbeRegistry(_ context.Context, request RegistryProbeRequest) RegistryProbeResult {
	f.registryProbeMu.Lock()
	f.registryProbeCalls++
	f.registryProbeMu.Unlock()
	return f.registryProbes[request.Registry.ID]
}
