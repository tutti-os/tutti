package agentstatus

import (
	"context"
	"os"
	"path/filepath"
	"strings"
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

func TestResolvedExistingManagedNodeRuntimeInheritsProcessPath(t *testing.T) {
	root := fakeManagedRuntimeRoot(t)
	inheritedPath := strings.Join([]string{t.TempDir(), t.TempDir()}, string(os.PathListSeparator))
	t.Setenv("PATH", inheritedPath)

	resolved, ok := resolvedExistingManagedNodeRuntime(root, nil)
	if !ok {
		t.Fatal("resolvedExistingManagedNodeRuntime() rejected compatible cache")
	}
	wantPath := filepath.Join(root, "node", "bin") + string(os.PathListSeparator) + inheritedPath
	if got := managedruntime.EnvValue(resolved.EnvOverrides, "PATH"); got != wantPath {
		t.Fatalf("PATH = %q, want %q", got, wantPath)
	}
}
