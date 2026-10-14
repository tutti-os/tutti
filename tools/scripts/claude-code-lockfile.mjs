export function pnpmPackageIntegrity(lockfile, packageName, version) {
  const packageKey = `${packageName}@${version}`;
  const lines = lockfile.split(/\r?\n/);
  let packageIndent = -1;
  let resolutionIndent = -1;

  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    const mapping = line.match(/^(\s*)(?:(['"])(.*?)\2|([^'"].*?)):\s*$/);
    if (packageIndent < 0) {
      const key = mapping?.[3] ?? mapping?.[4];
      if (key === packageKey) {
        packageIndent = indent;
      }
      continue;
    }

    if (line.trim() === "") {
      continue;
    }
    if (indent <= packageIndent) {
      return null;
    }

    const trimmed = line.trim();
    if (resolutionIndent >= 0) {
      if (indent <= resolutionIndent) {
        resolutionIndent = -1;
      } else {
        const integrity = integrityFromText(trimmed);
        if (integrity) {
          return integrity;
        }
        continue;
      }
    }
    if (trimmed === "resolution:") {
      resolutionIndent = indent;
      continue;
    }
    if (trimmed.startsWith("resolution:")) {
      return integrityFromText(trimmed);
    }
  }
  return null;
}

function integrityFromText(value) {
  return (
    value.match(/(?:^|[{,]\s*)integrity:\s*(sha512-[A-Za-z0-9+/=]+)/)?.[1] ??
    null
  );
}
