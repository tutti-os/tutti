package agentstatus

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
)

const downloadFileMaxAttempts = 3

func (s Service) downloadFile(ctx context.Context, sourceURL string, destinationPath string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, sourceURL, nil)
	if err != nil {
		return fmt.Errorf("create download request: %w", err)
	}
	var lastErr error
	for attempt := 1; attempt <= downloadFileMaxAttempts; attempt++ {
		err = s.downloadFileOnce(request, sourceURL, destinationPath)
		if err == nil {
			return nil
		}
		lastErr = err
		if attempt == downloadFileMaxAttempts || !isRetryableDownloadError(err) {
			return err
		}
		slog.Warn(
			"agent provider download failed, retrying",
			"url", sourceURL,
			"destination", destinationPath,
			"attempt", attempt,
			"maxAttempts", downloadFileMaxAttempts,
			"error", err,
		)
	}
	return lastErr
}

func (s Service) downloadFileOnce(request *http.Request, sourceURL string, destinationPath string) error {
	response, err := s.httpClient().Do(request)
	if err != nil {
		return fmt.Errorf("download %s: %w", sourceURL, err)
	}
	defer func() {
		_ = response.Body.Close()
	}()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return downloadStatusError{URL: sourceURL, StatusCode: response.StatusCode}
	}
	if err := os.MkdirAll(filepath.Dir(destinationPath), 0o755); err != nil {
		return fmt.Errorf("create download parent: %w", err)
	}
	target, err := os.OpenFile(destinationPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("create download destination: %w", err)
	}
	_, copyErr := io.Copy(target, response.Body)
	closeErr := target.Close()
	return errors.Join(copyErr, closeErr)
}

type downloadStatusError struct {
	URL        string
	StatusCode int
}

func (e downloadStatusError) Error() string {
	return fmt.Sprintf("download %s: unexpected status %d", e.URL, e.StatusCode)
}

func isRetryableDownloadError(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	var statusErr downloadStatusError
	if errors.As(err, &statusErr) {
		return statusErr.StatusCode == http.StatusRequestTimeout ||
			statusErr.StatusCode == http.StatusTooManyRequests ||
			statusErr.StatusCode >= 500
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return netErr.Timeout()
	}
	return false
}
