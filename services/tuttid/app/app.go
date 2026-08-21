package app

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
)

type App struct {
	Server          *http.Server
	Listener        net.Listener
	LogFilePath     string
	ShutdownTimeout time.Duration
	Logger          *slog.Logger
}

func New(server *http.Server, listener net.Listener, logFilePath string) *App {
	return &App{
		Server:          server,
		Listener:        listener,
		LogFilePath:     logFilePath,
		ShutdownTimeout: 5 * time.Second,
		Logger:          slog.Default(),
	}
}

func (a *App) Run(ctx context.Context) error {
	if a == nil || a.Server == nil {
		return errors.New("tutti app server is not configured")
	}

	logger := a.logger()
	logger.Info("tuttid listening", "event", "tutti.listen", "addr", a.Server.Addr, "log_file", a.LogFilePath)

	proxySource, proxyHost := runtimecmd.EffectiveProxySummary()
	logger.Info("tuttid outbound proxy resolved",
		"event", "tutti.proxy.resolved",
		"source", proxySource,
		"https_proxy_host", proxyHost,
	)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(sigCh)

	serveDone := make(chan error, 1)
	go func() {
		if a.Listener != nil {
			serveDone <- a.Server.Serve(a.Listener)
			return
		}
		serveDone <- a.Server.ListenAndServe()
	}()

	var err error
	select {
	case err = <-serveDone:
	case <-ctx.Done():
		a.shutdown(context.Background(), "context-cancelled", nil)
		err = <-serveDone
	case sig := <-sigCh:
		a.shutdown(context.Background(), "signal", sig)
		err = <-serveDone
	}

	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("tuttid server exited", "event", "tutti.listen.failed", "error_code", "server_serve_failed", "error", err)
		return err
	}

	return nil
}

func (a *App) shutdown(parent context.Context, reason string, sig os.Signal) {
	logger := a.logger()
	if sig != nil {
		logger.Info("tuttid received signal, shutting down", "event", "tutti.signal", "signal", sig)
	} else {
		logger.Info("tuttid shutting down", "event", "tutti.shutdown", "reason", reason)
	}

	timeout := a.ShutdownTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}

	shutdownCtx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	if err := a.Server.Shutdown(shutdownCtx); err != nil {
		logger.Warn("http server shutdown error", "event", "tutti.signal.shutdown_error", "error_code", "server_shutdown_failed", "error", err)
		return
	}

	logger.Info("http server shutdown complete", "event", "tutti.signal.shutdown_done")
}

func (a *App) logger() *slog.Logger {
	if a != nil && a.Logger != nil {
		return a.Logger
	}

	return slog.Default()
}
