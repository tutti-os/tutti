const { X509Certificate } = require("node:crypto");
const {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, extname, join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_TIMESTAMP_URL = "http://time.certum.pl";
const DEFAULT_DISPLAY_NAME = "Tutti";
const DEFAULT_DISPLAY_URL = "https://github.com/tutti-os/tutti";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Certum signing`);
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
  return result;
}

function sleep(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

function runWithRetries(command, args, { attempts, delaySeconds, label }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return run(command, args);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      process.stderr.write(
        `${label} failed (attempt ${attempt}/${attempts}); retrying in ${delaySeconds}s.\n`
      );
      sleep(delaySeconds);
    }
  }
  throw lastError;
}

function normalizedFingerprint(value) {
  return value.replace(/[^0-9a-f]/giu, "").toUpperCase();
}

function verifySignature(filePath) {
  const verification = run(
    "osslsigncode",
    [
      "verify",
      "-CAfile",
      "/etc/ssl/certs/ca-certificates.crt",
      "-TSA-CAfile",
      "/etc/ssl/certs/ca-certificates.crt",
      "-in",
      filePath
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const output = `${verification.stdout}\n${verification.stderr}`;
  if (
    !output.includes("Signature verification: ok") ||
    !output.includes("Timestamp Server Signature verification: ok")
  ) {
    throw new Error(
      `Authenticode or timestamp verification failed for ${filePath}`
    );
  }

  const expected = normalizedFingerprint(
    requiredEnv("CERTUM_CERT_FINGERPRINT")
  );
  if (!/^[0-9A-F]{64}$/u.test(expected)) {
    throw new Error(
      "CERTUM_CERT_FINGERPRINT must contain 64 hexadecimal characters"
    );
  }
  const workDir = mkdtempSync(join(tmpdir(), "tutti-certum-signature-"));
  try {
    const signaturePath = join(workDir, "signature.der");
    const certificatesPath = join(workDir, "certificates.pem");
    runWithRetries(
      "osslsigncode",
      ["extract-signature", "-in", filePath, "-out", signaturePath],
      {
        attempts: 3,
        delaySeconds: 2,
        label: `Extracting Authenticode signature from ${filePath}`
      }
    );
    const certificates = run("openssl", [
      "pkcs7",
      "-inform",
      "DER",
      "-in",
      signaturePath,
      "-print_certs"
    ]);
    writeFileSync(certificatesPath, certificates.stdout);
    const blocks =
      readFileSync(certificatesPath, "utf8").match(
        /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu
      ) ?? [];
    const fingerprints = blocks.map((block) =>
      normalizedFingerprint(new X509Certificate(block).fingerprint256)
    );
    if (!fingerprints.includes(expected))
      throw new Error(`Pinned Certum certificate was not found in ${filePath}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function signFile(filePath, metadata = {}) {
  const jsignJar = requiredEnv("JSIGN_JAR");
  const pkcs11Config = requiredEnv("TSH_CERTUM_PKCS11_CONFIG");
  const timestampUrl =
    process.env.TSH_CERTUM_TIMESTAMP_URL?.trim() || DEFAULT_TIMESTAMP_URL;
  const maxAttempts = Number.parseInt(
    process.env.TSH_CERTUM_SIGN_MAX_ATTEMPTS || "3",
    10
  );
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("TSH_CERTUM_SIGN_MAX_ATTEMPTS must be a positive integer");
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    process.stdout.write(
      `Signing ${basename(filePath)} (attempt ${attempt}/${maxAttempts}).\n`
    );
    const result = spawnSync(
      "java",
      [
        "-jar",
        jsignJar,
        "--storetype",
        "PKCS11",
        "--keystore",
        pkcs11Config,
        "--storepass",
        "",
        "--alg",
        "SHA-256",
        "--tsmode",
        "RFC3161",
        "--tsaurl",
        timestampUrl,
        "--replace",
        "--name",
        metadata.name || DEFAULT_DISPLAY_NAME,
        "--url",
        metadata.site || DEFAULT_DISPLAY_URL,
        filePath
      ],
      { stdio: "inherit" }
    );
    if (result.status === 0) {
      verifySignature(filePath);
      return;
    }
    if (attempt === maxAttempts)
      throw new Error(
        `jsign failed for ${filePath} after ${maxAttempts} attempts`
      );
    sleep(10);
  }
}

function findExecutables(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) files.push(...findExecutables(path));
    else if (stat.isFile() && extname(entry).toLowerCase() === ".exe")
      files.push(path);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function electronBuilderSign(configuration) {
  if (configuration.hash !== "sha256")
    throw new Error(
      `Certum signer only supports sha256, received ${configuration.hash}`
    );
  signFile(resolve(configuration.path), {
    name: configuration.name,
    site: configuration.site
  });
}

async function main(argv) {
  if (argv.length !== 2 || !["--root", "--verify-root"].includes(argv[0])) {
    throw new Error(
      "Usage: node certum-sign-windows.cjs <--root|--verify-root> <directory>"
    );
  }
  const root = resolve(argv[1]);
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new Error(`Signing root is not a directory: ${root}`);
  const executables = findExecutables(root);
  if (executables.length === 0)
    throw new Error(`No Windows executables found under ${root}`);
  const verifyOnly = argv[0] === "--verify-root";
  process.stdout.write(
    `${verifyOnly ? "Verifying" : "Signing"} ${executables.length} Windows executables.\n`
  );
  for (const executable of executables) {
    if (verifyOnly) verifySignature(executable);
    else signFile(executable);
  }
}

exports.default = electronBuilderSign;
exports.findExecutables = findExecutables;
exports.verifySignature = verifySignature;

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
