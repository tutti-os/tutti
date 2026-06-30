import type { AgentProvider } from "../../../../contexts/settings/domain/agentSettings";
import { getActiveUiLanguage, translate } from "../../../../i18n/index";
import {
  formatAppErrorMessage,
  isAppErrorDescriptor,
  TshAppError
} from "../../../../shared/errors/appError";

/** 在数字与非数字、非空白字符的边界插入空格（如「3小时前」→「3 小时前」）。 */
export function addSpacesAroundDigits(s: string): string {
  return s
    .replace(/(\d)([^\d\s])/g, "$1 $2")
    .replace(/([^\d\s])(\d)/g, "$1 $2");
}

const relativeTimeFormatterByLanguage = new Map<
  string,
  Intl.RelativeTimeFormat
>();
const dateTimeFormatterByLanguage = new Map<string, Intl.DateTimeFormat>();
const shortDateFormatterByLanguage = new Map<string, Intl.DateTimeFormat>();
const shortDateTimeFormatterByLanguage = new Map<string, Intl.DateTimeFormat>();
const weekdayTimeFormatterByLanguage = new Map<string, Intl.DateTimeFormat>();

function getRelativeTimeFormatter(language: string): Intl.RelativeTimeFormat {
  const cached = relativeTimeFormatterByLanguage.get(language);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  relativeTimeFormatterByLanguage.set(language, formatter);
  return formatter;
}

function getDateTimeFormatter(language: string): Intl.DateTimeFormat {
  const cached = dateTimeFormatterByLanguage.get(language);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
  dateTimeFormatterByLanguage.set(language, formatter);
  return formatter;
}

function getShortDateFormatter(language: string): Intl.DateTimeFormat {
  const cached = shortDateFormatterByLanguage.get(language);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat(language, {
    month: language === "en" ? "short" : "numeric",
    day: "numeric"
  });
  shortDateFormatterByLanguage.set(language, formatter);
  return formatter;
}

function getShortDateTimeFormatter(language: string): Intl.DateTimeFormat {
  const cached = shortDateTimeFormatterByLanguage.get(language);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat(language, {
    month: language === "en" ? "short" : "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  shortDateTimeFormatterByLanguage.set(language, formatter);
  return formatter;
}

function getWeekdayTimeFormatter(language: string): Intl.DateTimeFormat {
  const cached = weekdayTimeFormatterByLanguage.get(language);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat(language, {
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  weekdayTimeFormatterByLanguage.set(language, formatter);
  return formatter;
}

function toLocalWeekdayTime(
  value: Date | number,
  language = getActiveUiLanguage()
): string {
  const formatter = getWeekdayTimeFormatter(language);
  const parts = formatter.formatToParts(value);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  if (weekday && hour && minute) {
    return `${weekday} ${hour}:${minute}`;
  }

  return formatter.format(value);
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof TshAppError) {
    return formatAppErrorMessage(error);
  }

  if (isAppErrorDescriptor(error)) {
    return formatAppErrorMessage(error);
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  return translate("common.unknownError");
}

export function toAgentNodeTitle(
  provider: AgentProvider,
  model: string | null
): string {
  const providerTitle =
    provider === "claude-code"
      ? "claude"
      : provider === "nexight"
        ? "nexight"
        : provider === "opencode"
          ? "opencode"
          : provider === "gemini"
            ? "gemini"
            : provider === "openclaw"
              ? "openclaw"
              : provider === "hermes"
                ? "hermes"
                : "codex";
  return `${providerTitle} · ${model ?? translate("common.defaultModel")}`;
}

export function toLocalDateTime(iso: string | null): string {
  const formatter = getDateTimeFormatter(getActiveUiLanguage());

  if (!iso) {
    return formatter.format(Date.now());
  }

  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) {
    return iso;
  }

  return formatter.format(timestamp);
}

export function toLocalShortDate(
  value: Date | number,
  language = getActiveUiLanguage()
): string {
  return getShortDateFormatter(language).format(value);
}

export function toLocalShortDateTime(
  value: Date | number,
  language = getActiveUiLanguage()
): string {
  return getShortDateTimeFormatter(language).format(value);
}

export function formatUnixTimestampAsLocalShortDateTime(
  unix?: number | null,
  language = getActiveUiLanguage()
): string {
  if (!unix || !Number.isFinite(unix)) {
    return "—";
  }

  const value = unix > 1_000_000_000_000 ? unix : unix * 1000;
  return toLocalShortDateTime(value, language);
}

export function formatAgentMessageTimestamp(
  unix?: number | null,
  language = getActiveUiLanguage(),
  now: Date = new Date()
): string | null {
  if (unix == null || !Number.isFinite(unix)) {
    return null;
  }

  const value = unix > 1_000_000_000_000 ? unix : unix * 1000;
  const messageDate = new Date(value);
  const startOfWeek = new Date(now);
  const daysSinceMonday = (startOfWeek.getDay() + 6) % 7;
  startOfWeek.setHours(0, 0, 0, 0);
  startOfWeek.setDate(startOfWeek.getDate() - daysSinceMonday);

  if (messageDate.getTime() >= startOfWeek.getTime()) {
    return toLocalWeekdayTime(value, language);
  }

  return toLocalShortDateTime(value, language);
}

export function toRelativeTime(iso: string | null): string {
  const formatter = getRelativeTimeFormatter(getActiveUiLanguage());

  if (!iso) {
    return addSpacesAroundDigits(formatter.format(0, "second"));
  }

  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) {
    return addSpacesAroundDigits(formatter.format(0, "second"));
  }

  const deltaSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 60) {
    return addSpacesAroundDigits(formatter.format(0, "second"));
  }

  if (deltaSeconds < 3600) {
    return addSpacesAroundDigits(
      formatter.format(-Math.floor(deltaSeconds / 60), "minute")
    );
  }

  if (deltaSeconds < 86400) {
    return addSpacesAroundDigits(
      formatter.format(-Math.floor(deltaSeconds / 3600), "hour")
    );
  }

  const deltaDays = Math.floor(deltaSeconds / 86400);
  if (deltaDays < 30) {
    return addSpacesAroundDigits(formatter.format(-deltaDays, "day"));
  }

  const deltaMonths = Math.floor(deltaDays / 30);
  if (deltaMonths < 12) {
    return addSpacesAroundDigits(formatter.format(-deltaMonths, "month"));
  }

  return addSpacesAroundDigits(
    formatter.format(-Math.floor(deltaDays / 365), "year")
  );
}
