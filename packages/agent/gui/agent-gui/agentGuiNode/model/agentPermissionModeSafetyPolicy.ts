const fullAccessConfirmationModesByProvider: Readonly<
  Record<string, readonly string[]>
> = {
  codex: ["full-access"]
};

export function requiresFullAccessSafetyConfirmation(
  provider: string,
  permissionModeId: string
): boolean {
  return (
    fullAccessConfirmationModesByProvider[provider]?.includes(
      permissionModeId
    ) ?? false
  );
}
