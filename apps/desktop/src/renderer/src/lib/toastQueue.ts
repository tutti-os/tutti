export type DesktopToastTone = "default" | "destructive" | "success";

export interface DesktopToastItem {
  description?: string;
  id: string;
  title: string;
  tone: DesktopToastTone;
}

export function enqueueDesktopToast(
  current: DesktopToastItem[],
  next: DesktopToastItem,
  limit: number
): DesktopToastItem[] {
  const duplicate = current.some(
    (toast) =>
      toast.tone === next.tone &&
      toast.title === next.title &&
      toast.description === next.description
  );
  if (duplicate) {
    return current;
  }
  return [next, ...current].slice(0, limit);
}
