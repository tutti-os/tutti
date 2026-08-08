import { accessSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const DEFAULT_ENV_KEYS = [
  "TUTTI_CHECKOUT_ROOT",
  "TUTTI_AGENT_SESSION_REPLAY_TUTTI_ROOT"
];

/**
 * Resolve a Tutti checkout root for local-link consumption of this package.
 *
 * Resolution order:
 * 1. Explicit `checkoutRoot` option
 * 2. Env (`TUTTI_CHECKOUT_ROOT` / `TUTTI_AGENT_SESSION_REPLAY_TUTTI_ROOT`)
 * 3. Absolute/relative `use` paths in go.work under Tutti `packages/agent`
 * 4. Sibling layouts relative to `productRoot` (TSH: ../../tutti-os/tutti)
 */
export function resolveTuttiCheckoutRoot(options = {}) {
  const explicit = String(options.checkoutRoot ?? "").trim();
  if (explicit) {
    return assertTuttiCheckout(resolve(explicit));
  }

  for (const key of options.envKeys ?? DEFAULT_ENV_KEYS) {
    const value = String(process.env[key] ?? "").trim();
    if (value) {
      return assertTuttiCheckout(resolve(value));
    }
  }

  const productRoot = String(options.productRoot ?? "").trim();
  const goWorkPath = String(
    options.goWorkPath ?? (productRoot ? join(productRoot, "go.work") : "")
  ).trim();
  if (goWorkPath) {
    const fromGoWork = tuttiRootFromGoWork(goWorkPath);
    if (fromGoWork) {
      return assertTuttiCheckout(fromGoWork);
    }
  }

  if (productRoot) {
    for (const candidate of siblingTuttiCandidates(productRoot)) {
      if (isTuttiCheckout(candidate)) {
        return candidate;
      }
    }
  }

  throw new Error(
    "Unable to resolve Tutti checkout for @tutti-os/agent-session-replay-runner. " +
      "Set TUTTI_CHECKOUT_ROOT or ensure go.work / sibling ../../tutti-os/tutti layout."
  );
}

function siblingTuttiCandidates(productRoot) {
  const root = resolve(productRoot);
  return [
    join(root, "../../tutti-os/tutti"),
    join(root, "../tutti-os/tutti"),
    join(root, "../tutti"),
    join(root, "../../tutti")
  ].map((path) => resolve(path));
}

function tuttiRootFromGoWork(goWorkPath) {
  let contents;
  try {
    contents = readFileSync(goWorkPath, "utf8");
  } catch {
    return null;
  }
  const agentPackageMarker = join("packages", "agent");
  for (const match of contents.matchAll(/^\s*([^\s#]+)\s*$/gmu)) {
    const raw = match[1];
    if (
      raw === "." ||
      raw === "use" ||
      raw === "(" ||
      raw === ")" ||
      raw === "go"
    ) {
      continue;
    }
    if (
      !raw.startsWith("/") &&
      !raw.startsWith("./") &&
      !raw.startsWith("../")
    ) {
      continue;
    }
    const absolute = resolve(dirname(goWorkPath), raw);
    const index = absolute.lastIndexOf(agentPackageMarker);
    if (index === -1) continue;
    const tuttiRoot = absolute.slice(0, index).replace(/[/\\]+$/u, "") || "/";
    if (isTuttiCheckout(tuttiRoot)) {
      return tuttiRoot;
    }
  }
  return null;
}

function assertTuttiCheckout(root) {
  if (!isTuttiCheckout(root)) {
    throw new Error(`path is not a Tutti checkout: ${root}`);
  }
  return root;
}

function isTuttiCheckout(root) {
  try {
    accessSync(
      join(root, "packages", "agent", "session-replay-runner", "package.json")
    );
    return true;
  } catch {
    try {
      accessSync(join(root, "packages", "agent", "session-replay", "go.mod"));
      return true;
    } catch {
      return false;
    }
  }
}
