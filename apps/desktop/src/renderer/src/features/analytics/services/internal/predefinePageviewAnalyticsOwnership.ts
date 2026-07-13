export function shouldReportPredefinePageview(search: string): boolean {
  const value = new URLSearchParams(search).get("reportPredefinePageview");
  return value === null || value === "1";
}
