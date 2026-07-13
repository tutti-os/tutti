export function toElectronGlobalShortcutAccelerator(
  binding: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  const parts = binding.split("+").map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => !part)) {
    return null;
  }
  const key = parts.at(-1);
  if (!key || /\s/u.test(key) || normalizeModifier(key, platform)) {
    return null;
  }
  const modifiers: string[] = [];
  const seenModifiers = new Set<string>();
  for (const part of parts.slice(0, -1)) {
    const modifier = normalizeModifier(part, platform);
    if (!modifier || seenModifiers.has(modifier)) {
      return null;
    }
    modifiers.push(modifier);
    seenModifiers.add(modifier);
  }
  if (modifiers.length === 0 && !/^F(?:[1-9]|1\d|2[0-4])$/iu.test(key)) {
    return null;
  }
  return [...modifiers, key].join("+");
}

function normalizeModifier(
  value: string,
  platform: NodeJS.Platform
): string | null {
  switch (value.toLowerCase()) {
    case "meta":
      return platform === "darwin" ? "Command" : "Super";
    case "ctrl":
    case "control":
      return "Control";
    case "alt":
      return "Alt";
    case "shift":
      return "Shift";
    case "commandorcontrol":
      return "CommandOrControl";
    default:
      return null;
  }
}
