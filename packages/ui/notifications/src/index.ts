import { createDecorator } from "@tutti-os/infra/di";

export type NotificationLevel = "success" | "error" | "info" | "warning";

export interface NotificationInput {
  description?: string;
  title: string;
}

export interface NotificationMessage extends NotificationInput {
  level: NotificationLevel;
}

export interface NotificationService {
  readonly _serviceBrand: undefined;

  notify(input: NotificationMessage): void;
  success(input: NotificationInput): void;
  error(input: NotificationInput): void;
  info(input: NotificationInput): void;
  warning(input: NotificationInput): void;
}

export const INotificationService = createDecorator<NotificationService>(
  "notification-service"
);
