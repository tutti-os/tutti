package host

import "testing"

func TestExecutionTargetUsesCanonicalGoTuple(t *testing.T) {
	target, err := ExecutionTarget(" Linux ", "ARM64")
	if err != nil {
		t.Fatal(err)
	}
	if target != "linux-arm64" {
		t.Fatalf("ExecutionTarget() = %q, want linux-arm64", target)
	}
	if _, err := ExecutionTarget("linux", "aarch64"); err == nil {
		t.Fatal("ExecutionTarget() accepted a non-canonical architecture")
	}
}

func TestResolveTargetImplementationRequiresExactTarget(t *testing.T) {
	darwin := Implementation{Kind: ImplementationKindManagedStdio, ManagedStdio: &ManagedStdioImplementation{Runtime: RuntimeRequirement{ABI: "node22-darwin-arm64"}}}
	linux := Implementation{Kind: ImplementationKindBuiltin}
	implementations := map[string]Implementation{"darwin-arm64": darwin, "linux-arm64": linux}
	got, err := ResolveTargetImplementation("linux-arm64", implementations)
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind != ImplementationKindBuiltin {
		t.Fatalf("ResolveTargetImplementation() = %#v", got)
	}
	if _, err := ResolveTargetImplementation("windows-arm64", implementations); err == nil {
		t.Fatal("ResolveTargetImplementation() fell back to another target")
	}
	implementations["linux-arm64"] = Implementation{Kind: ImplementationKindManagedStdio, ManagedStdio: &ManagedStdioImplementation{Runtime: RuntimeRequirement{ABI: "node22-darwin-arm64"}}}
	if _, err := ResolveTargetImplementation("linux-arm64", implementations); err == nil {
		t.Fatal("ResolveTargetImplementation() accepted a mismatched runtime ABI")
	}
}
