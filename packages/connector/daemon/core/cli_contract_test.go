package host

import "testing"

func TestManagedCLIContractHashIsStableAcrossCommandOrderAndDescriptions(t *testing.T) {
	first := ManagedCLIInterface{Arguments: []string{"--json"}, Commands: []CLICommand{
		{Name: "send", Description: "first description", Arguments: []string{"message", "send"},
			InputSchema: map[string]any{"properties": map[string]any{"text": map[string]any{"type": "string"}}, "type": "object"}, TimeoutMS: 10_000},
		{Name: "read", Arguments: []string{"message", "read"}, InputSchema: map[string]any{"type": "object"}, TimeoutMS: 5_000},
	}}
	second := ManagedCLIInterface{Arguments: []string{"--json"}, Commands: []CLICommand{
		{Name: "read", Description: "changed", Arguments: []string{"message", "read"}, InputSchema: map[string]any{"type": "object"}, TimeoutMS: 5_000},
		{Name: "send", Arguments: []string{"message", "send"},
			InputSchema: map[string]any{"type": "object", "properties": map[string]any{"text": map[string]any{"type": "string"}}}, TimeoutMS: 10_000},
	}}

	firstHash, err := ManagedCLIContractHash(first)
	if err != nil {
		t.Fatal(err)
	}
	secondHash, err := ManagedCLIContractHash(second)
	if err != nil {
		t.Fatal(err)
	}
	if firstHash != secondHash {
		t.Fatalf("expected equivalent contracts to hash equally: %q != %q", firstHash, secondHash)
	}
}

func TestManagedCLIContractHashChangesWithInvocationSemantics(t *testing.T) {
	base := ManagedCLIInterface{TimeoutMS: 10_000}
	changed := base
	changed.Arguments = []string{"--json"}

	baseHash, err := ManagedCLIContractHash(base)
	if err != nil {
		t.Fatal(err)
	}
	changedHash, err := ManagedCLIContractHash(changed)
	if err != nil {
		t.Fatal(err)
	}
	if baseHash == changedHash {
		t.Fatal("expected invocation-semantic change to alter the contract hash")
	}
}

func TestManagedCLICommandNameSupportsExplicitAndLegacyManifests(t *testing.T) {
	if got := ManagedCLICommandName(ManagedCLIInterface{Entrypoint: "bin/lark-cli"}); got != "lark-cli" {
		t.Fatalf("legacy command = %q", got)
	}
	if got := ManagedCLICommandName(ManagedCLIInterface{Entrypoint: "bin/implementation.mjs", Command: "lark-cli"}); got != "lark-cli" {
		t.Fatalf("explicit command = %q", got)
	}
}
