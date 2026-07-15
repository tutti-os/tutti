package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	tuttiapp "github.com/tutti-os/tutti/services/tuttid/app"
	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout io.Writer, stderr io.Writer) int {
	if exitCode, shouldExit := handleArguments(args, stdout, stderr); shouldExit {
		return exitCode
	}

	signal.Ignore(syscall.SIGPIPE)

	pidLease, err := acquirePIDFile()
	if err != nil {
		fmt.Fprintf(stderr, "acquire tuttid pid file: %v\n", err)
		return 1
	}
	defer pidLease.Release()

	loggerSetup, err := tuttiapp.SetupLoggerFromEnv()
	if err != nil {
		fmt.Fprintf(stderr, "configure tuttid logger: %v\n", err)
		return 1
	}
	defer func() {
		if closeErr := loggerSetup.Close(); closeErr != nil {
			fmt.Fprintf(stderr, "close tuttid logger: %v\n", closeErr)
		}
	}()

	slog.SetDefault(loggerSetup.Logger)
	recoverInstallCommandLock(slog.Default())

	parentCtx, cancelParentMonitor := contextWithDesktopParentMonitor(context.Background(), slog.Default())
	defer cancelParentMonitor()

	ctx, stop := signal.NotifyContext(parentCtx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	srv, listener, wiring, err := buildTuttiServer()
	if err != nil {
		fmt.Fprintf(stderr, "build tuttid server: %v\n", err)
		return 1
	}
	defer func() {
		_ = wiring.Close()
	}()

	if err := tuttiapp.New(srv, listener, loggerSetup.LogFilePath).Run(ctx); err != nil {
		fmt.Fprintf(stderr, "tuttid exited: %v\n", err)
		return 1
	}
	return 0
}

const tuttidUsage = `Usage: tuttid [options]

Runs the Tutti local daemon. Tutti Desktop normally manages this process.

Options:
  -h, --help  Show this help.
`

func handleArguments(args []string, stdout io.Writer, stderr io.Writer) (int, bool) {
	if len(args) == 0 {
		return 0, false
	}
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		fmt.Fprint(stdout, tuttidUsage)
		return 0, true
	}

	fmt.Fprintf(stderr, "tuttid: unexpected arguments: %s\n\n%s", strings.Join(args, " "), tuttidUsage)
	return 2, true
}

func recoverInstallCommandLock(logger *slog.Logger) {
	result, err := agentstatusservice.RecoverDefaultInstallCommandLock()
	if err != nil {
		logger.Warn("failed to recover npm install lock",
			"event", "tutti.agentstatus.install_lock.recovery_failed",
			"lock_path", result.LockPath,
			"error", err)
		return
	}
	if !result.Removed {
		return
	}
	logger.Info("recovered stale npm install lock",
		"event", "tutti.agentstatus.install_lock.recovered",
		"lock_path", result.LockPath,
		"pid", result.PID,
		"reason", result.Reason)
}

func contextWithDesktopParentMonitor(parent context.Context, logger *slog.Logger) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(parent)
	parentPIDText := strings.TrimSpace(os.Getenv("TUTTI_DESKTOP_PARENT_PID"))
	if parentPIDText == "" {
		return ctx, cancel
	}

	parentPID, err := strconv.Atoi(parentPIDText)
	if err != nil || parentPID <= 1 {
		logger.Warn("invalid desktop parent pid; parent monitor disabled",
			"event", "tutti.parent_monitor.invalid_pid",
			"value", parentPIDText)
		return ctx, cancel
	}

	initialPPID := os.Getppid()
	logger.Info("tuttid desktop parent monitor started",
		"event", "tutti.parent_monitor.started",
		"parent_pid", parentPID,
		"initial_ppid", initialPPID)

	go func() {
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				currentPPID := os.Getppid()
				parentWasDirect := initialPPID == parentPID
				parentChanged := parentWasDirect && currentPPID != parentPID
				parentGone := !tuttitypes.ProcessExists(parentPID)
				if !parentChanged && !parentGone {
					continue
				}
				logger.Warn("desktop parent process disappeared; shutting down tuttid",
					"event", "tutti.parent_monitor.parent_gone",
					"parent_pid", parentPID,
					"initial_ppid", initialPPID,
					"current_ppid", currentPPID,
					"parent_was_direct", parentWasDirect,
					"parent_changed", parentChanged,
					"parent_gone", parentGone)
				cancel()
				return
			}
		}
	}()

	return ctx, cancel
}
