import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultMaxSubmitAttempts = 3;
const defaultRetryDelayMs = 15_000;
const requiredNotarizationEnv = [
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER"
];

function hasNotarizationEnvironment(env) {
  return requiredNotarizationEnv.every((name) => Boolean(env[name]));
}

function formatOutput(value) {
  return typeof value === "string" ? value.trim() : "";
}

function logMessage(logger, message) {
  logger.log(`[notarize-dmg] ${message}`);
}

function writeCommandOutput(logger, result) {
  const stdout = formatOutput(result?.stdout);
  const stderr = formatOutput(result?.stderr);

  if (stdout.trim()) {
    logger.log(stdout);
  }
  if (stderr.trim()) {
    logger.error(stderr);
  }
}

function resolveDmgArtifactPaths(buildResult) {
  return [
    ...new Set(
      (buildResult.artifactPaths ?? []).filter((filePath) =>
        filePath.endsWith(".dmg")
      )
    )
  ].sort();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonOutput(output) {
  const text = formatOutput(output);
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readNotarySubmission(error) {
  const stdoutResult = parseJsonOutput(error?.stdout);
  const stderrResult = parseJsonOutput(error?.stderr);
  return stdoutResult ?? stderrResult;
}

function isNonRetryableSubmitFailure(error) {
  const submission = readNotarySubmission(error);
  return submission?.status === "Invalid";
}

function buildNotaryCredentialsArgs(env) {
  return [
    "--key",
    env.APPLE_API_KEY,
    "--key-id",
    env.APPLE_API_KEY_ID,
    "--issuer",
    env.APPLE_API_ISSUER
  ];
}

export function createDmgArtifactNotarizer({
  env = process.env,
  logger = console,
  maxSubmitAttempts = defaultMaxSubmitAttempts,
  platform = process.platform,
  retryDelayMs = defaultRetryDelayMs,
  runCommand = execFileAsync,
  waitForRetry = wait
} = {}) {
  async function run(command, args, label) {
    logMessage(logger, label ?? `${command} ${args.join(" ")}`);
    try {
      const result = await runCommand(command, args, {
        maxBuffer: 1024 * 1024 * 20
      });
      writeCommandOutput(logger, result);
      return result;
    } catch (error) {
      writeCommandOutput(logger, error);
      throw error;
    }
  }

  async function logNotarySubmissionFailure(error) {
    const submission = readNotarySubmission(error);
    if (!submission?.id) {
      return;
    }

    try {
      await run(
        "xcrun",
        [
          "notarytool",
          "log",
          submission.id,
          ...buildNotaryCredentialsArgs(env)
        ],
        `xcrun notarytool log ${submission.id}`
      );
    } catch {
      logMessage(logger, `unable to fetch notarytool log ${submission.id}`);
    }
  }

  async function submitDmgForNotarization(dmgPath, displayName) {
    const submitArgs = [
      "notarytool",
      "submit",
      dmgPath,
      ...buildNotaryCredentialsArgs(env),
      "--wait",
      "--output-format",
      "json"
    ];

    for (let attempt = 1; attempt <= maxSubmitAttempts; attempt += 1) {
      try {
        await run(
          "xcrun",
          submitArgs,
          `xcrun notarytool submit ${displayName} --wait`
        );
        return;
      } catch (error) {
        if (
          attempt >= maxSubmitAttempts ||
          isNonRetryableSubmitFailure(error)
        ) {
          await logNotarySubmissionFailure(error);
          throw error;
        }

        logMessage(
          logger,
          `notarytool submit failed for ${displayName}; retrying (${attempt + 1}/${maxSubmitAttempts})`
        );
        await waitForRetry(retryDelayMs);
      }
    }
  }

  async function notarizeDmg(dmgPath) {
    const displayName = path.basename(dmgPath);
    await submitDmgForNotarization(dmgPath, displayName);
    await run("xcrun", ["stapler", "staple", "-v", dmgPath]);
    await run("xcrun", ["stapler", "validate", dmgPath]);
    await run("spctl", ["-a", "-vv", "-t", "install", dmgPath]);
  }

  return async function notarizeMacDmgArtifacts(buildResult) {
    if (platform !== "darwin" || !hasNotarizationEnvironment(env)) {
      return [];
    }

    await Promise.all(resolveDmgArtifactPaths(buildResult).map(notarizeDmg));

    return [];
  };
}

export default createDmgArtifactNotarizer();
