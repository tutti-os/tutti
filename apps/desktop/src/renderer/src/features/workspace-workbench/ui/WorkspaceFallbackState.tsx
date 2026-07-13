import {
  Button,
  CardDescription,
  CardTitle,
  LoadingIcon,
  WarningLinedIcon
} from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";

export interface WorkspaceFallbackStateProps {
  description: string;
  isLoading?: boolean;
  onRetry?: () => void;
  title: string;
  tone?: "default" | "destructive";
}

export function WorkspaceFallbackState({
  description,
  isLoading = false,
  onRetry,
  title,
  tone = "default"
}: WorkspaceFallbackStateProps) {
  const { t } = useTranslation();

  return (
    <main className="min-h-screen px-4 py-5 sm:px-6 sm:py-7">
      <div className="mx-auto flex min-h-[calc(100vh-2.5rem)] max-w-3xl items-center justify-center">
        <div className="flex max-w-3xl flex-col items-center text-center">
          <div
            className={cn(
              "text-primary",
              tone === "destructive" && "text-[var(--state-danger)]"
            )}
          >
            {isLoading ? (
              <LoadingIcon className="size-9 animate-spin" />
            ) : (
              <WarningLinedIcon className="size-9" />
            )}
          </div>
          <div className="mt-6 flex flex-col items-center gap-3">
            <CardTitle className="text-3xl tracking-tight">{title}</CardTitle>
            <CardDescription className="text-[15px] text-muted-foreground">
              {description}
            </CardDescription>
            {onRetry ? (
              <Button
                className="mt-3 h-10 rounded-lg px-4"
                type="button"
                onClick={onRetry}
              >
                {t("workspace.fallback.retryAction")}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  );
}
