import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const readyPattern = /Ctrl-C to stop the recording/iu;

export function buildAllProcessTimeProfileArgs(outputPath) {
  return [
    "xctrace",
    "record",
    "--template",
    "Time Profiler",
    "--all-processes",
    "--no-prompt",
    "--output",
    outputPath
  ];
}

export async function startAllProcessTimeProfile(input) {
  if (process.platform !== "darwin") {
    throw new Error("all-process Time Profiler capture requires macOS");
  }
  const child = spawn(
    "xcrun",
    buildAllProcessTimeProfileArgs(input.outputPath),
    {
      cwd: input.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let output = "";
  const append = (chunk) => {
    output = (output + chunk.toString()).slice(-20_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  let exitResult = null;
  const exit = new Promise((resolveExit) => {
    child.once("error", (error) => {
      exitResult = { error };
      resolveExit(exitResult);
    });
    child.once("exit", (code, signal) => {
      exitResult = { code, signal };
      resolveExit(exitResult);
    });
  });
  const deadline = Date.now() + (input.timeoutMs ?? 30_000);
  while (!readyPattern.test(output)) {
    if (exitResult) {
      throw new Error(
        `xctrace exited before recording (${exitResult.error?.message ?? exitResult.code ?? exitResult.signal ?? "unknown"})${output.trim() ? `: ${output.trim()}` : ""}`
      );
    }
    if (Date.now() >= deadline) {
      child.kill("SIGKILL");
      await exit;
      throw new Error(
        `timed out waiting for xctrace Time Profiler${output.trim() ? `: ${output.trim()}` : ""}`
      );
    }
    await delay(100);
  }

  let stopped = false;
  return {
    outputPath: input.outputPath,
    async stop() {
      if (stopped) return;
      stopped = true;
      child.kill("SIGINT");
      const result = await Promise.race([exit, delay(45_000).then(() => null)]);
      if (!result) {
        child.kill("SIGKILL");
        await exit;
        throw new Error("timed out saving xctrace Time Profiler capture");
      }
      if (result.code !== 0) {
        throw new Error(
          `xctrace failed (${result.error?.message ?? result.code ?? result.signal ?? "unknown"})${output.trim() ? `: ${output.trim()}` : ""}`
        );
      }
    }
  };
}
