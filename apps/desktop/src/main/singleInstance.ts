export interface SingleInstanceDeps {
  requestSingleInstanceLock: () => boolean;
  quit: () => void;
  onSecondInstance: (handler: (argv: readonly string[]) => void) => void;
  focusPrimaryWindow: () => void;
  handleSecondInstanceArgv?: (argv: readonly string[]) => void;
}

/**
 * Enforce a single live desktop instance per environment.
 *
 * The managed `tuttid` daemon is a global singleton (one pid/listener file per
 * env root). Without this guard, launching a second Tutti process would run the
 * daemon startup path and reap the first instance's live daemon as if it were a
 * stale orphan, leaving the first instance unable to talk to its daemon.
 *
 * Returns `true` for the primary instance (continue boot) and `false` for a
 * secondary instance (already asked to quit; the caller must stop booting).
 */
export function ensureSingleInstance(deps: SingleInstanceDeps): boolean {
  if (!deps.requestSingleInstanceLock()) {
    deps.quit();
    return false;
  }

  deps.onSecondInstance((argv) => {
    deps.handleSecondInstanceArgv?.(argv);
    deps.focusPrimaryWindow();
  });
  return true;
}
