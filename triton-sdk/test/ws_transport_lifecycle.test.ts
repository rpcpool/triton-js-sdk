import { describe, expect, it, vi } from "vitest";
import type { TransportHandlers } from "../src/core/transport";
import {
  WsAccountSubscriptionTransport,
  type WebSocketLike
} from "../src/transport/ws";

class FakeSocket implements WebSocketLike {
  public readyState = 0;
  public binaryType = "";
  public closeCalls = 0;
  private readonly listeners = new Map<
    string,
    Set<(...args: unknown[]) => void>
  >();

  send(): void {}

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
    this.emit("close");
  }

  addEventListener(
    event: string,
    handler: (...args: unknown[]) => void
  ): void {
    const handlers = this.listeners.get(event) ?? new Set();
    handlers.add(handler);
    this.listeners.set(event, handlers);
  }

  removeEventListener(
    event: string,
    handler: (...args: unknown[]) => void
  ): void {
    this.listeners.get(event)?.delete(handler);
  }

  emit(event: string, value?: unknown): void {
    for (const handler of [...(this.listeners.get(event) ?? [])]) {
      handler(value);
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

function handlers(): TransportHandlers {
  return {
    onAccountUpdate: vi.fn(),
    onTransportError: vi.fn()
  };
}

describe("WsAccountSubscriptionTransport lifecycle", () => {
  it("times out and closes a socket that never opens", async () => {
    const socket = new FakeSocket();
    const transport = new WsAccountSubscriptionTransport(
      "ws://127.0.0.1:12000",
      () => socket,
      5
    );

    await expect(
      transport.connect(handlers(), new AbortController().signal)
    ).rejects.toMatchObject({ name: "AccountSyncConnectTimeoutError" });
    expect(socket.closeCalls).toBe(1);
  });

  it("aborts and closes a connecting socket", async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    const transport = new WsAccountSubscriptionTransport(
      "ws://127.0.0.1:12000",
      () => socket,
      1_000
    );

    const connection = transport.connect(handlers(), controller.signal);
    await waitFor(() => socket.listenerCount("open") === 1);
    controller.abort();

    await expect(connection).rejects.toMatchObject({ name: "AbortError" });
    expect(socket.closeCalls).toBe(1);
  });

  it("opens successfully before the timeout", async () => {
    const socket = new FakeSocket();
    const transport = new WsAccountSubscriptionTransport(
      "ws://127.0.0.1:12000",
      () => socket,
      1_000
    );

    const connection = transport.connect(
      handlers(),
      new AbortController().signal
    );
    await waitFor(() => socket.listenerCount("open") === 1);
    socket.readyState = 1;
    socket.emit("open");

    await expect(connection).resolves.toBeUndefined();
    await transport.close();
  });

  it("ignores late socket events and removes listeners after timeout", async () => {
    const socket = new FakeSocket();
    const transportHandlers = handlers();
    const transport = new WsAccountSubscriptionTransport(
      "ws://127.0.0.1:12000",
      () => socket,
      5
    );

    await expect(
      transport.connect(transportHandlers, new AbortController().signal)
    ).rejects.toMatchObject({ name: "AccountSyncConnectTimeoutError" });

    socket.emit("open");
    socket.emit("error", new Error("late error"));
    socket.emit("close");
    expect(transportHandlers.onTransportError).not.toHaveBeenCalled();
    expect(socket.listenerCount("open")).toBe(0);
    expect(socket.listenerCount("error")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("message")).toBe(0);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
