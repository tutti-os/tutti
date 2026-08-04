package main

import (
	"context"
	"log/slog"
	"time"

	"github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
)

func startManagedRuntimeProfilePreload(preloader managedruntime.ProfilePreloader) {
	go func() {
		startedAt := time.Now()
		slog.Info("managed runtime profile preload started", "event", "tutti.managed_runtime.profile_preload_started", "profile", managedruntime.NodeStaticProfile)
		if err := preloader.PreloadProfile(context.Background(), managedruntime.NodeStaticProfile); err != nil {
			slog.Warn("managed runtime profile preload failed", "event", "tutti.managed_runtime.profile_preload_failed", "profile", managedruntime.NodeStaticProfile, "durationMs", time.Since(startedAt).Milliseconds(), "error", err)
			return
		}
		slog.Info("managed runtime profile preload completed", "event", "tutti.managed_runtime.profile_preload_completed", "profile", managedruntime.NodeStaticProfile, "durationMs", time.Since(startedAt).Milliseconds())
	}()
}
