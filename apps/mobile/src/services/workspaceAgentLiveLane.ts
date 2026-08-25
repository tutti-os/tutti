import {
  createAgentActivityWorkspaceEventCoordinator,
  type AgentActivityDurableMessage,
  type AgentActivityLiveEvent,
  type AgentActivitySnapshot,
  type AgentActivityTurn,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import type {
  AgentLiveAttachmentControl,
  AgentLiveDelivery,
  ClockPort,
  DeviceLinkPort
} from "./servicePorts";
import type { WorkspaceConversationRailService } from "./workspaceConversationRailService";
import type { WorkspaceNavigationService } from "./workspaceNavigationService";

const AGENT_LIVE_RETRY_MS = 1_000;
const RAIL_RECONCILE_DELAY_MS = 250;

interface WorkspaceAgentLiveLaneOptions {
  clock: ClockPort;
  deviceLink?: DeviceLinkPort;
  engine: AgentSessionEngine;
  isAvailable(): boolean;
  navigation: WorkspaceNavigationService;
  onActivityChanged(): void;
  onConnectionChanged(
    connected: boolean,
    failure?: Extract<
      AgentLiveDelivery,
      { kind: "connection"; status: "disconnected" }
    >
  ): void;
  rail: WorkspaceConversationRailService;
  readCanonicalActivity(): AgentActivitySnapshot;
  workspaceId: string;
}

export class WorkspaceAgentLiveLane {
  private readonly coordinator;
  private active = false;
  private connected = false;
  private retryTask: { cancel(): void } | null = null;
  private railReconcileTask: { cancel(): void } | null = null;
  private subscription: { close(): void } | null = null;
  private subscriptionGeneration = 0;
  // Mobile currently opens every native stream from epoch/sequence zero, so
  // this projection has the same lifetime as the subscription. A future
  // persisted resume cursor must persist this fence with it.
  private attachmentFence: {
    attachment: AgentLiveAttachmentControl;
    caughtUp: boolean;
  } | null = null;

  constructor(private readonly options: WorkspaceAgentLiveLaneOptions) {
    this.coordinator = createAgentActivityWorkspaceEventCoordinator({
      engine: options.engine,
      notificationScheduler: {
        schedule: (delayMs, task) => options.clock.schedule(delayMs, task)
      },
      readCanonicalSnapshot: options.readCanonicalActivity,
      workspaceId: options.workspaceId
    });
  }

  start(): void {
    this.active = true;
    if (!this.options.deviceLink || this.subscription) return;
    this.retryTask?.cancel();
    this.retryTask = null;
    this.attachmentFence = null;
    const subscriptionGeneration = ++this.subscriptionGeneration;
    const subscription = this.options.deviceLink.subscribeAgentLive(
      this.options.workspaceId,
      (delivery) => {
        if (subscriptionGeneration !== this.subscriptionGeneration) return;
        this.handleDelivery(delivery);
      }
    );
    if (
      subscriptionGeneration !== this.subscriptionGeneration ||
      !this.active ||
      !this.options.isAvailable()
    ) {
      subscription.close();
      return;
    }
    this.subscription = subscription;
  }

  stop(): void {
    const wasActive = this.active;
    this.active = false;
    this.retryTask?.cancel();
    this.retryTask = null;
    this.railReconcileTask?.cancel();
    this.railReconcileTask = null;
    this.subscriptionGeneration += 1;
    this.subscription?.close();
    this.subscription = null;
    this.attachmentFence = null;
    if (wasActive) {
      this.coordinator.eventStreamConnectionChanged({
        status: "disconnected"
      });
    }
    this.setConnected(false);
  }

  dispose(): void {
    this.stop();
    this.coordinator.dispose();
  }

  isConnected(): boolean {
    return this.connected;
  }

  project(canonical: AgentActivitySnapshot): AgentActivitySnapshot {
    return this.coordinator.project(canonical);
  }

  reconcileMessages(agentSessionId: string): void {
    this.coordinator.reconcileMessages(agentSessionId);
  }

  reconcileAuthoritativeHistory(
    agentSessionId: string,
    canonicalMessages: readonly AgentActivityDurableMessage[],
    effectiveTurns: readonly AgentActivityTurn[]
  ): void {
    this.coordinator.reconcileAuthoritativeHistory(
      agentSessionId,
      canonicalMessages,
      effectiveTurns
    );
  }

  isSessionDeleted(agentSessionId: string): boolean {
    return this.coordinator.isSessionDeleted(agentSessionId);
  }

  private handleDelivery(delivery: AgentLiveDelivery): void {
    if (!this.active || !this.options.isAvailable()) return;
    if (delivery.kind === "connection") {
      if (delivery.status === "connected") {
        const selectedSessionId =
          this.options.navigation.getSnapshot().selectedAgentSessionId;
        this.coordinator.eventStreamConnectionChanged({
          status: "connected",
          ...(selectedSessionId
            ? { prioritySessionIds: [selectedSessionId] }
            : {})
        });
        this.setConnected(true);
        return;
      }
      this.subscriptionGeneration += 1;
      this.subscription?.close();
      this.subscription = null;
      this.attachmentFence = null;
      this.coordinator.eventStreamConnectionChanged({
        status: "disconnected"
      });
      this.setConnected(false, true, delivery);
      if (delivery.retryable) {
        this.scheduleRetry();
      }
      return;
    }
    if (delivery.kind === "session_deleted") {
      this.coordinator.removeSession(delivery.agentSessionId);
      this.options.navigation.reconcileSessionIds(
        this.coordinator
          .project(this.options.readCanonicalActivity())
          .sessions.map((session) => session.agentSessionId)
      );
      this.options.onActivityChanged();
      this.scheduleRailReconcile();
      return;
    }
    if (delivery.kind === "session_restored") {
      this.coordinator.ingestEvent({
        agentSessionId: delivery.agentSessionId,
        data: {
          agentSessionId: delivery.agentSessionId,
          eventType: "session_restored",
          restoredAtUnixMs: 0,
          workspaceId: this.options.workspaceId
        },
        eventType: "session_restored",
        workspaceId: this.options.workspaceId
      });
      this.options.onActivityChanged();
      this.scheduleRailReconcile();
      return;
    }
    if (delivery.kind === "discontinuity") {
      this.reconcileDiscontinuity(delivery);
      return;
    }
    if (delivery.kind === "attachment_changed") {
      this.handleAttachmentChanged(delivery.attachment);
      return;
    }
    if (delivery.kind === "attachment_caught_up") {
      this.handleAttachmentCaughtUp(delivery.attachment);
      return;
    }
    this.applyEvent(delivery.event);
  }

  private handleAttachmentChanged(
    attachment: AgentLiveAttachmentControl
  ): void {
    if (attachment.workspaceId !== this.options.workspaceId) {
      this.rejectAttachmentFence("attachment_identity_mismatch");
      return;
    }
    if (this.attachmentFence && !this.attachmentFence.caughtUp) {
      this.rejectAttachmentFence("attachment_changed_before_catch_up");
      return;
    }
    this.attachmentFence = { attachment, caughtUp: false };
    this.reconcileDiscontinuity({
      kind: "discontinuity",
      reason: "attachment_changed",
      reconcileKeys: []
    });
  }

  private handleAttachmentCaughtUp(
    attachment: AgentLiveAttachmentControl
  ): void {
    const current = this.attachmentFence;
    if (!current || !sameAttachmentControl(current.attachment, attachment)) {
      this.rejectAttachmentFence("attachment_catch_up_mismatch");
      return;
    }
    this.attachmentFence = {
      attachment: current.attachment,
      caughtUp: true
    };
  }

  private rejectAttachmentFence(reason: string): void {
    this.attachmentFence = null;
    this.subscriptionGeneration += 1;
    this.subscription?.close();
    this.subscription = null;
    this.coordinator.eventStreamConnectionChanged({
      status: "disconnected"
    });
    this.setConnected(false, true);
    this.reconcileDiscontinuity({
      kind: "discontinuity",
      reason,
      reconcileKeys: []
    });
    this.scheduleRetry();
  }

  private applyEvent(event: AgentActivityLiveEvent): void {
    const result = this.coordinator.ingestEvent(event);
    if (result.optimisticMessage || result.inlineApplied) {
      this.options.onActivityChanged();
    }
    if (result.accepted && event.eventType !== "message_delta") {
      this.scheduleRailReconcile();
    }
  }

  private reconcileDiscontinuity(
    delivery: Extract<AgentLiveDelivery, { kind: "discontinuity" }>
  ): void {
    const selectedSessionId =
      this.options.navigation.getSnapshot().selectedAgentSessionId;
    this.coordinator.reconcileDiscontinuity({
      fallbackSessionIds: selectedSessionId ? [selectedSessionId] : [],
      reconcileKeys: delivery.reconcileKeys
    });
    this.scheduleRailReconcile();
  }

  private scheduleRetry(): void {
    this.retryTask?.cancel();
    if (!this.active || this.subscription || !this.options.isAvailable())
      return;
    this.retryTask = this.options.clock.schedule(AGENT_LIVE_RETRY_MS, () => {
      this.retryTask = null;
      this.start();
    });
  }

  private scheduleRailReconcile(): void {
    if (this.railReconcileTask || !this.active || !this.options.isAvailable()) {
      return;
    }
    this.railReconcileTask = this.options.clock.schedule(
      RAIL_RECONCILE_DELAY_MS,
      () => {
        this.railReconcileTask = null;
        void this.options.rail.reconcile().catch(() => undefined);
      }
    );
  }

  private setConnected(
    connected: boolean,
    observedFailure = false,
    failure?: Extract<
      AgentLiveDelivery,
      { kind: "connection"; status: "disconnected" }
    >
  ): void {
    if (this.connected !== connected) {
      this.connected = connected;
      this.options.rail.setLiveConnected(connected);
      this.options.onConnectionChanged(connected, failure);
      return;
    }
    if (observedFailure) {
      this.options.onConnectionChanged(false, failure);
    }
  }
}

function sameAttachmentControl(
  left: AgentLiveAttachmentControl,
  right: AgentLiveAttachmentControl
): boolean {
  return (
    left.bindingId === right.bindingId &&
    left.workspaceId === right.workspaceId &&
    left.agentSessionId === right.agentSessionId &&
    left.canonicalTurnId === right.canonicalTurnId &&
    left.callerTurnId === right.callerTurnId &&
    left.attachmentRevision === right.attachmentRevision
  );
}
