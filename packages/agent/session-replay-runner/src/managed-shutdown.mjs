function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/**
 * Stop a detached Desktop tree when this process is interrupted, when
 * stdout/stderr break (owner gone), or when an explicit parent PID exits.
 *
 * Products must inject `stopDesktop` (no Electron / process-tree policy here).
 * Tutti may set `exitOnSignal: true` so SIGINT/SIGTERM finish with 130/143 after
 * Desktop stops; TSH historically only stops the tree.
 *
 * @param {unknown} desktop
 * @param {{
 *   clearInterval?: typeof clearInterval,
 *   exitOnSignal?: boolean,
 *   isProcessAlive?: (pid: number) => boolean,
 *   parentPid?: string | null,
 *   processRuntime?: NodeJS.Process,
 *   setInterval?: typeof setInterval,
 *   stopDesktop: (desktop: unknown) => unknown
 * }} options
 */
export function bindManagedReplayShutdown(
  desktop,
  {
    clearInterval: clearIntervalFn = clearInterval,
    exitOnSignal = false,
    isProcessAlive = defaultIsProcessAlive,
    parentPid = process.env.TUTTI_AGENT_SESSION_REPLAY_PARENT_PID,
    processRuntime = process,
    setInterval: setIntervalFn = setInterval,
    stopDesktop
  } = {}
) {
  if (typeof stopDesktop !== "function") {
    throw new Error("bindManagedReplayShutdown requires stopDesktop");
  }
  let stopping = false;
  const stop = (exitCode = null) => {
    if (stopping) return;
    stopping = true;
    void Promise.resolve(stopDesktop(desktop))
      .catch(() => undefined)
      .finally(() => {
        if (
          exitOnSignal &&
          exitCode != null &&
          typeof processRuntime.exit === "function"
        ) {
          processRuntime.exit(exitCode);
        }
      });
  };
  const onSigInt = () => stop(exitOnSignal ? 130 : null);
  const onSigTerm = () => stop(exitOnSignal ? 143 : null);
  const onOutputError = (error) => {
    if (error?.code === "EPIPE") {
      stop();
    }
  };
  const parsedParentPid = Number.parseInt(parentPid?.trim() ?? "", 10);
  const parentCheckInterval =
    Number.isSafeInteger(parsedParentPid) && parsedParentPid > 0
      ? setIntervalFn(() => {
          if (!isProcessAlive(parsedParentPid)) {
            stop(exitOnSignal ? 1 : null);
          }
        }, 500)
      : null;
  parentCheckInterval?.unref?.();
  processRuntime.once("SIGINT", onSigInt);
  processRuntime.once("SIGTERM", onSigTerm);
  processRuntime.stdout?.on("error", onOutputError);
  processRuntime.stderr?.on("error", onOutputError);
  return () => {
    if (parentCheckInterval) {
      clearIntervalFn(parentCheckInterval);
    }
    processRuntime.off("SIGINT", onSigInt);
    processRuntime.off("SIGTERM", onSigTerm);
    processRuntime.stdout?.off("error", onOutputError);
    processRuntime.stderr?.off("error", onOutputError);
  };
}
