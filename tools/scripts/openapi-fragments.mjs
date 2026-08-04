import { dirname, resolve } from "node:path";

export function normalizeOpenApiFragmentRefs(value, extensionKey) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${extensionKey} must be an array`);
  }
  return value.map((entry) => normalizeOpenApiFragmentRef(entry, extensionKey));
}

export function resolveOpenApiFragmentPath(
  fragmentRef,
  { repoRoot, specPath, resolvePackageSpecifier }
) {
  if (typeof fragmentRef === "string") {
    if (fragmentRef.startsWith(".")) {
      return resolve(dirname(specPath), fragmentRef);
    }
    return resolve(repoRoot, fragmentRef);
  }

  const specifier = `${fragmentRef.package}/${fragmentRef.path}`;
  try {
    return resolvePackageSpecifier(specifier);
  } catch (error) {
    throw new Error(
      `Cannot resolve OpenAPI fragment ${specifier}; install an exact released package version before generation`,
      { cause: error }
    );
  }
}

function normalizeOpenApiFragmentRef(entry, extensionKey) {
  if (typeof entry === "string") {
    const value = entry.trim();
    if (value === "") {
      throw new Error(`${extensionKey} cannot contain empty entries`);
    }
    return value;
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(
      `${extensionKey} entries must be paths or package/path objects`
    );
  }
  const packageName = String(entry.package ?? "").trim();
  const packagePath = String(entry.path ?? "").trim();
  const keys = Object.keys(entry);
  if (
    packageName === "" ||
    packagePath === "" ||
    keys.some((key) => key !== "package" && key !== "path")
  ) {
    throw new Error(
      `${extensionKey} package entries require only non-empty package and path fields`
    );
  }
  const packagePathSegments = packagePath.split(/[\\/]/u);
  if (
    packagePath.startsWith("/") ||
    packagePathSegments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`${extensionKey} package paths must be package-relative`);
  }
  return { package: packageName, path: packagePath };
}
