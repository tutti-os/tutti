const MAX_WORKSPACE_FILE_ENTRY_NAME_BYTES = 255;

export function validateWorkspaceFileEntryName(
  name: string
): "invalid" | "required" | "tooLong" | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return "required";
  }
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed === "." ||
    trimmed === ".."
  ) {
    return "invalid";
  }
  if (
    new TextEncoder().encode(trimmed).byteLength >
    MAX_WORKSPACE_FILE_ENTRY_NAME_BYTES
  ) {
    return "tooLong";
  }
  return null;
}
