package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	managedruntime "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
)

type fakeRTKProfileResolver struct {
	path    string
	profile string
}

func (resolver *fakeRTKProfileResolver) ResolveProfile(_ context.Context, profile string) (managedruntime.ResolvedRuntime, error) {
	resolver.profile = profile
	return managedruntime.ResolvedRuntime{RTK: resolver.path}, nil
}

func TestResolveTuttiRTKExecutablePrefersBundledDesktopBinary(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rtk")
	if err := os.WriteFile(path, []byte("rtk"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv(tuttiBundledRTKPathEnv, path)
	resolver := &fakeRTKProfileResolver{}
	got, err := resolveTuttiRTKExecutable(t.Context(), resolver)
	if err != nil {
		t.Fatal(err)
	}
	if got != path || resolver.profile != "" {
		t.Fatalf("resolved path/profile = %q/%q, want bundled path without managed lookup", got, resolver.profile)
	}
}

func TestResolveTuttiRTKExecutableFallsBackToManagedRuntime(t *testing.T) {
	t.Setenv(tuttiBundledRTKPathEnv, "")
	path := filepath.Join(t.TempDir(), "rtk")
	if err := os.WriteFile(path, []byte("rtk"), 0o700); err != nil {
		t.Fatal(err)
	}
	resolver := &fakeRTKProfileResolver{path: path}
	got, err := resolveTuttiRTKExecutable(t.Context(), resolver)
	if err != nil {
		t.Fatal(err)
	}
	if got != path || resolver.profile != managedruntime.RTKSaverProfile {
		t.Fatalf("resolved path/profile = %q/%q", got, resolver.profile)
	}
}
