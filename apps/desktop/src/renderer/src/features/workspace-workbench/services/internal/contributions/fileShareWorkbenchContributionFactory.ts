import { workspaceWorkbenchDesktopI18nKeys } from "@shared/i18n";
import type {
  DesktopWorkbenchContributionContext,
  DesktopWorkbenchContributionFactory
} from "../workspaceWorkbenchContributionFactory.ts";
import { createWorkspaceFileShareContribution } from "../workspaceFileShareContribution.tsx";

type FileShareWorkbenchContributionContext = Pick<
  DesktopWorkbenchContributionContext,
  "i18n"
>;

export const fileShareWorkbenchContributionFactory: DesktopWorkbenchContributionFactory<FileShareWorkbenchContributionContext> =
  {
    create(context) {
      return createWorkspaceFileShareContribution({
        label: context.i18n.t(
          workspaceWorkbenchDesktopI18nKeys.nodes.fileShare
        ),
        loadingLabel: context.i18n.t(
          workspaceWorkbenchDesktopI18nKeys.fileShare.loading
        )
      });
    },
    id: "workspace-file-share",
    order: 7
  };
