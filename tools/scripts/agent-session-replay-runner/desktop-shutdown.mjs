import { stopProcessTree } from "../run-agent-gui-performance.mjs";

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/**
 * Stop a detached Desktop/tuttid tree when this process is interrupted, when
 * stdout/stderr break (owner gone), or when an explicit parent PID exits.
 * Desktop is spawned detached, so killing only the runner leaves Dock orphans.
 */
export function bindManagedReplayShutdown(
  desktop,
  {
    clearInterval: clearIntervalFn = clearInterval,
    isProcessAlive = defaultIsProcessAlive,
    parentPid = process.env.TUTTI_AGENT_SESSION_REPLAY_PARENT_PID,
    processRuntime = process,
    setInterval: setIntervalFn = setInterval,
    stopDesktop = stopProcessTree
  } = {}
) {
  let stopping = false;
  const stop = (exitCode = null) => {
    if (stopping) return;
    stopping = true;
    void Promise.resolve(stopDesktop(desktop))
      .catch(() => undefined)
      .finally(() => {
        // Signal/parent handlers remove the default exit; finish after Desktop
        // stops. Skip when the host is a test double without exit().
        if (exitCode != null && typeof processRuntime.exit === "function") {
          processRuntime.exit(exitCode);
        }
      });
  };
  const onSigInt = () => stop(130);
  const onSigTerm = () => stop(143);
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
            stop(1);
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
