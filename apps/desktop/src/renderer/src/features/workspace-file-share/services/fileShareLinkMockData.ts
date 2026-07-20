import type { TranslateFn } from "@renderer/i18n";

export interface FileShareComment {
  id: string;
  author: string;
  avatar: string;
  timestamp: string;
  content: string;
}

export interface FileShareLinkedMessage {
  id: string;
  role: "user" | "agent";
  sender: string;
  timestamp: string;
  content: string;
  artifact?: { name: string; meta: string };
}

export interface FileShareDemoData {
  comments: FileShareComment[];
  conversation: {
    agentName: string;
    messages: FileShareLinkedMessage[];
    ownerName: string;
    title: string;
    updatedAt: string;
  };
  file: {
    contentType: string;
    name: string;
    ownerAvatar: string;
    size: string;
  };
  markdownSource: string;
}

export function createFileShareDemoData(t: TranslateFn): FileShareDemoData {
  const fileName = t("workspace.workbenchDesktop.fileShare.demoFileName");
  const ownerName = t("workspace.workbenchDesktop.fileShare.demoOwnerName");
  const ownerAvatar = t("workspace.workbenchDesktop.fileShare.demoFileOwner");
  const agentName = "Codex";

  return {
    comments: [
      {
        author: "Alice",
        avatar: "A",
        content: t("workspace.workbenchDesktop.fileShare.demoCommentAlice"),
        id: "c1",
        timestamp: t(
          "workspace.workbenchDesktop.fileShare.demoCommentAliceTimestamp"
        )
      },
      {
        author: "Bob",
        avatar: "B",
        content: t("workspace.workbenchDesktop.fileShare.demoCommentBob"),
        id: "c2",
        timestamp: t(
          "workspace.workbenchDesktop.fileShare.demoCommentBobTimestamp"
        )
      },
      {
        author: ownerName,
        avatar: ownerAvatar,
        content: t("workspace.workbenchDesktop.fileShare.demoCommentOwner"),
        id: "c3",
        timestamp: t(
          "workspace.workbenchDesktop.fileShare.demoCommentOwnerTimestamp"
        )
      }
    ],
    conversation: {
      agentName,
      messages: [
        {
          content: t("workspace.workbenchDesktop.fileShare.demoUserMessage"),
          id: "m1",
          role: "user",
          sender: ownerName,
          timestamp: "14:58"
        },
        {
          content: t(
            "workspace.workbenchDesktop.fileShare.demoAgentAcknowledgement"
          ),
          id: "m2",
          role: "agent",
          sender: agentName,
          timestamp: "15:01"
        },
        {
          artifact: {
            meta: `7.05 KB · ${t("workspace.workbenchDesktop.fileShare.demoFileContentType")}`,
            name: fileName
          },
          content: t("workspace.workbenchDesktop.fileShare.demoAgentResult"),
          id: "m3",
          role: "agent",
          sender: agentName,
          timestamp: "15:29"
        }
      ],
      ownerName,
      title: t("workspace.workbenchDesktop.fileShare.linkedConversationTitle"),
      updatedAt: "2026-06-27 15:32"
    },
    file: {
      contentType: "application/octet-stream",
      name: fileName,
      ownerAvatar,
      size: "7.05 KB"
    },
    markdownSource: t("workspace.workbenchDesktop.fileShare.demoMarkdownSource")
  };
}
