package storesqlite

import (
	"context"
	"errors"
	"time"

	sqlitedriver "modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

// A busy result means that the transaction did not commit and is safe to
// replay from its beginning. Keep the retry deliberately small: it smooths
// transient WAL/checkpoint contention without hiding a second process that
// owns the database for an unbounded period.
const sqliteBusyRetryAttempts = 3
const sqliteBusyRetryBudget = 5 * time.Second

var sqliteBusyRetryBackoff = [...]time.Duration{
	50 * time.Millisecond,
	100 * time.Millisecond,
}

func isSQLiteBusyError(err error) bool {
	var sqliteErr *sqlitedriver.Error
	return errors.As(err, &sqliteErr) && sqliteErr.Code()&0xff == sqlite3.SQLITE_BUSY
}

func retrySQLiteBusy(ctx context.Context, operation func(context.Context) error) error {
	retryCtx, cancel := context.WithTimeout(ctx, sqliteBusyRetryBudget)
	defer cancel()

	for attempt := 1; attempt <= sqliteBusyRetryAttempts; attempt++ {
		err := operation(retryCtx)
		if err == nil || !isSQLiteBusyError(err) || attempt == sqliteBusyRetryAttempts {
			return err
		}
		if err := waitSQLiteBusyRetry(retryCtx, sqliteBusyRetryBackoff[attempt-1]); err != nil {
			return err
		}
	}
	return nil
}

func waitSQLiteBusyRetry(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
