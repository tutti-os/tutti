package agentstatus

import (
	"context"
	"path/filepath"
	"slices"
	"testing"

	"github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
)

func TestResolvedExistingManagedNodeRuntimeRejectsBrokenCorepack(t *testing.T) {
	root := fakeManagedRuntimeRoot(t)
	writeExecutable(
		t,
		filepath.Join(root, "node", "bin", corepackBinaryNameForTest()),
		"#!/bin/sh\nexit 0\n",
	)

	if runtime, ok := resolvedExistingManagedNodeRuntime(root, func() []string {
		return []string{"PATH=/usr/bin:/bin"}
	}); ok {
		t.Fatalf("resolvedExistingManagedNodeRuntime() = %#v, want incompatible cache rejected", runtime)
	}
}

func TestResolveManagedNodeRuntimeForProviderDoesNotUseBrokenOptionalCache(t *testing.T) {
	root := fakeManagedRuntimeRoot(t)
	writeExecutable(
		t,
		filepath.Join(root, "node", "bin", corepackBinaryNameForTest()),
		"#!/bin/sh\nexit 0\n",
	)
	service := Service{
		Environ: func() []string {
			return []string{"PATH=/usr/bin:/bin"}
		},
		ManagedRuntime: managedruntime.DefaultResolver{RuntimeRoot: root},
	}

	if runtime, ok := service.resolveManagedNodeRuntimeForProvider(context.Background(), false); ok {
		t.Fatalf("resolveManagedNodeRuntimeForProvider() = %#v, want incompatible optional cache skipped", runtime)
	}
}

func TestResolvedExistingManagedNodeRuntimeAcceptsCompatibleCorepack(t *testing.T) {
	root := fakeManagedRuntimeRoot(t)

	runtime, ok := resolvedExistingManagedNodeRuntime(root, func() []string {
		return []string{"PATH=/usr/bin:/bin"}
	})
	if !ok {
		t.Fatal("resolvedExistingManagedNodeRuntime() rejected compatible cache")
	}
	wantNode := filepath.Join(root, "node", "bin", nodeBinaryNameForTest())
	if runtime.Node != wantNode {
		t.Fatalf("Node = %q, want %q", runtime.Node, wantNode)
	}
}

func TestResolvedExistingManagedNodeRuntimeInheritsProcessPathWhenEnvironUnset(t *testing.T) {
	root := fakeManagedRuntimeRoot(t)
	inheritedBinDir := t.TempDir()
	t.Setenv("PATH", inheritedBinDir)

	resolved, ok := resolvedExistingManagedNodeRuntime(root, nil)
	if !ok {
		t.Fatal("resolvedExistingManagedNodeRuntime() rejected compatible cache")
	}
	pathDirs := filepath.SplitList(managedruntime.EnvValue(resolved.EnvOverrides, "PATH"))
	if !slices.Contains(pathDirs, inheritedBinDir) {
		t.Fatalf("PATH = %#v, want inherited process path %q", pathDirs, inheritedBinDir)
	}
}
