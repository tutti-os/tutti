import assert from "node:assert/strict";
import test from "node:test";
import type { NotificationService } from "@tutti-os/ui-notifications";
import { createTranslator } from "../../../../../shared/i18n/index.ts";
import { registerWorkspaceAppPopupNotifications } from "./workspaceAppPopupNotifications.ts";

test("workspace popup notifications explain unsupported authorization popup modes", () => {
  const notifications: Array<{ description?: string; title: string }> = [];
  let listener:
    | ((event: {
        reason: "deferred-navigation-unsupported" | "post-unsupported";
      }) => void)
    | undefined;
  let disposed = 0;
  const dispose = registerWorkspaceAppPopupNotifications({
    workspaceAppApi: {
      onPopupRejected(nextListener) {
        listener = nextListener;
        return () => {
          disposed += 1;
        };
      }
    },
    notifications: {
      error(input) {
        notifications.push(input);
      }
    } as NotificationService,
    translate: createTranslator("en").t
  });

  listener?.({ reason: "post-unsupported" });
  listener?.({ reason: "deferred-navigation-unsupported" });
  dispose();

  assert.deepEqual(notifications, [
    {
      description:
        "POST-based popups are not supported. Try another sign-in method or contact the app provider.",
      title: "This app cannot open the authorization popup"
    },
    {
      description:
        "Popups that navigate after opening are not supported. Try another sign-in method or contact the app provider.",
      title: "This app cannot open the authorization popup"
    }
  ]);
  assert.equal(disposed, 1);
});
