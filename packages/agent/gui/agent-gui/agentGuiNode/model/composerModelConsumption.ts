export function consumptionMultiplierFromText(
  text: string
): string | undefined {
  const match = text.match(
    /^\s*(?:x\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*x)\s*credits?\s*$/i
  );
  const value = match?.[1] ?? match?.[2];
  return value ? `${value}x` : undefined;
}
