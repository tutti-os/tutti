import {
  DeviceLinkAttemptEvents,
  deviceLinkAttemptEventsForTests
} from "./deviceLinkAttemptEvents";

class FakeSocket {
  static instances: FakeSocket[] = [];
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data?: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.();
  }

  emitOpen(): void {
    this.onopen?.();
  }

  emitMessage(data: string): void {
    this.onmessage?.({ data });
  }
}

describe("DeviceLinkAttemptEvents", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  it("routes a V2 business wake frame to the attempt listener", () => {
    const listener = jest.fn();
    const source = new DeviceLinkAttemptEvents({
      realtimeURL: "wss://ws.example.test/realtime?lane=test",
      socketConstructor: FakeSocket
    });
    const subscription = source.start("session-1", "device-1", listener);
    const socket = FakeSocket.instances[0]!;
    expect(socket.url).toContain("deviceId=device-1");
    socket.emitOpen();
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      action: "connection.initialize",
      data: { protocolVersion: 2 }
    });
    expect(JSON.parse(socket.sent[1]!)).toEqual({
      action: "init",
      data: { deviceId: "device-1" }
    });
    socket.emitMessage(
      JSON.stringify({
        content_type: "PAYLOAD_CONTENT_TYPE_JSON",
        delivery: { device_id: "device-1", scope: "user_device" },
        dispatch_id: "dispatch-1",
        event_id: "event-1",
        event_type: "device_link.attempt.changed",
        occurred_at: new Date().toISOString(),
        payload: btoa(JSON.stringify({ attemptId: "attempt-1" })),
        protocol_version: 2,
        schema_version: 1
      })
    );
    expect(listener).toHaveBeenCalledWith("attempt-1");
    subscription.close();
  });

  it("ignores malformed or non-attempt frames", () => {
    expect(
      deviceLinkAttemptEventsForTests.parseAttemptChangedPayload("not-json")
    ).toBeNull();
    expect(
      deviceLinkAttemptEventsForTests.parseAttemptChangedPayload(
        JSON.stringify({
          payload: { attemptId: "attempt-1" },
          protocol_version: 2,
          type: "room.message"
        })
      )
    ).toBeNull();
  });

  it("rejects a non-websocket endpoint before dialing", () => {
    expect(() =>
      deviceLinkAttemptEventsForTests.appendDeviceID(
        "https://ws.example.test/realtime",
        "device-1"
      )
    ).toThrow("ws or wss");
  });
});
