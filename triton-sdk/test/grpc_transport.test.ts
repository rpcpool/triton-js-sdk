import { beforeEach, describe, expect, it, vi } from "vitest";

const grpcMock = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class FakeStream {
    public readonly writes: unknown[] = [];
    public readonly writeCallbacks: Array<
      (error?: Error | null | undefined) => void
    > = [];
    public writeReturn = true;
    public autoCompleteWrites = true;
    public cancelled = false;
    private readonly listeners = new Map<string, Set<Listener>>();

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? new Set<Listener>();
      listeners.add(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    off(event: string, listener: Listener): this {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
        listener(...args);
      }
    }

    write(
      request: unknown,
      callback: (error?: Error | null | undefined) => void
    ): boolean {
      this.writes.push(request);
      this.writeCallbacks.push(callback);
      if (this.autoCompleteWrites) {
        queueMicrotask(() => callback());
      }
      return this.writeReturn;
    }

    cancel(): void {
      this.cancelled = true;
    }
  }

  class FakeClient {
    public readonly constructorArgs: unknown[];
    public readonly streams: FakeStream[] = [];
    public readonly metadata: unknown[] = [];
    public closed = false;

    constructor(args: unknown[]) {
      this.constructorArgs = args;
    }

    subscribe(metadata: unknown): FakeStream {
      this.metadata.push(metadata);
      const stream = queuedStreams.shift() ?? new FakeStream();
      this.streams.push(stream);
      return stream;
    }

    close(): void {
      this.closed = true;
    }
  }

  const clients: FakeClient[] = [];
  const queuedStreams: FakeStream[] = [];

  return { clients, queuedStreams, FakeClient, FakeStream };
});

vi.mock("../src/generated/grpc/account_sync", () => ({
  YellowstoneAccountSyncGrpcServiceClient: vi.fn(function MockGrpcClient(
    ...args: unknown[]
  ) {
    const client = new grpcMock.FakeClient(args);
    grpcMock.clients.push(client);
    return client;
  })
}));

import { GrpcAccountSubscriptionTransport } from "../src/transport/grpc";

function createHandlers() {
  return {
    onAccountUpdate: vi.fn(),
    onTransportError: vi.fn()
  };
}

describe("GrpcAccountSubscriptionTransport", () => {
  beforeEach(() => {
    grpcMock.clients.length = 0;
    grpcMock.queuedStreams.length = 0;
  });

  it("passes fixed window and keepalive settings to grpc-js", async () => {
    const transport = new GrpcAccountSubscriptionTransport(
      "https://api.example.com/test-token"
    );
    await transport.connect(createHandlers(), new AbortController().signal);

    expect(grpcMock.clients[0].constructorArgs[2]).toEqual({
      "grpc-node.flow_control_window": 16 * 1024 * 1024,
      "grpc.max_receive_message_length": 16 * 1024 * 1024,
      "grpc.keepalive_time_ms": 30_000,
      "grpc.keepalive_timeout_ms": 10_000,
      "grpc.keepalive_permit_without_calls": 1
    });
    expect(
      (grpcMock.clients[0].metadata[0] as { get(key: string): unknown }).get(
        "x-token"
      )
    ).toEqual(["test-token"]);
    await transport.close();
  });

  it("passes custom channel settings to grpc-js", async () => {
    const transport = new GrpcAccountSubscriptionTransport(
      "http://localhost:10000",
      {
        flowControlWindowBytes: 8 * 1024 * 1024,
        maxReceiveMessageLengthBytes: 32 * 1024 * 1024,
        keepAliveIntervalMs: 20_000,
        keepAliveTimeoutMs: 5_000,
        keepAlivePermitWithoutCalls: false
      }
    );
    await transport.connect(createHandlers(), new AbortController().signal);

    expect(grpcMock.clients[0].constructorArgs[2]).toEqual({
      "grpc-node.flow_control_window": 8 * 1024 * 1024,
      "grpc.max_receive_message_length": 32 * 1024 * 1024,
      "grpc.keepalive_time_ms": 20_000,
      "grpc.keepalive_timeout_ms": 5_000,
      "grpc.keepalive_permit_without_calls": 0
    });
    await transport.close();
  });

  it("waits for both the write callback and drain", async () => {
    const stream = new grpcMock.FakeStream();
    stream.autoCompleteWrites = false;
    stream.writeReturn = false;
    grpcMock.queuedStreams.push(stream);
    const transport = new GrpcAccountSubscriptionTransport("http://localhost:10000");
    await transport.connect(createHandlers(), new AbortController().signal);

    let settled = false;
    const write = transport.setTrackedAccounts(["A1"], "confirmed").then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(stream.writes).toHaveLength(1));
    stream.writeCallbacks[0]();
    await Promise.resolve();
    expect(settled).toBe(false);

    stream.emit("drain");
    await write;
    expect(settled).toBe(true);
    await transport.close();
  });

  it("does not mark a failed write as applied", async () => {
    const firstStream = new grpcMock.FakeStream();
    firstStream.autoCompleteWrites = false;
    const secondStream = new grpcMock.FakeStream();
    grpcMock.queuedStreams.push(firstStream, secondStream);
    const handlers = createHandlers();
    const transport = new GrpcAccountSubscriptionTransport("http://localhost:10000");
    await transport.connect(handlers, new AbortController().signal);

    const writeError = new Error("write failed");
    const firstWrite = transport.setTrackedAccounts(["A1"], "confirmed");
    await vi.waitFor(() => expect(firstStream.writes).toHaveLength(1));
    firstStream.writeCallbacks[0](writeError);
    await expect(firstWrite).rejects.toBe(writeError);
    expect(firstStream.cancelled).toBe(true);
    expect(handlers.onTransportError).toHaveBeenCalledWith(writeError);

    await transport.setTrackedAccounts(["A1"], "confirmed");
    expect(secondStream.writes).toHaveLength(1);
    await transport.close();
  });

  it("skips a duplicate set only after a successful write", async () => {
    const stream = new grpcMock.FakeStream();
    grpcMock.queuedStreams.push(stream);
    const transport = new GrpcAccountSubscriptionTransport("http://localhost:10000");
    await transport.connect(createHandlers(), new AbortController().signal);

    await transport.setTrackedAccounts(["A1"], "confirmed");
    await transport.setTrackedAccounts(["A1"], "confirmed");

    expect(stream.writes).toHaveLength(1);
    await transport.close();
  });

  it("rejects a pending write and finishes close", async () => {
    const stream = new grpcMock.FakeStream();
    stream.autoCompleteWrites = false;
    stream.writeReturn = false;
    grpcMock.queuedStreams.push(stream);
    const transport = new GrpcAccountSubscriptionTransport("http://localhost:10000");
    await transport.connect(createHandlers(), new AbortController().signal);

    const write = transport.setTrackedAccounts(["A1"], "confirmed");
    await vi.waitFor(() => expect(stream.writes).toHaveLength(1));
    await expect(Promise.allSettled([write, transport.close()])).resolves.toEqual([
      expect.objectContaining({ status: "rejected" }),
      { status: "fulfilled", value: undefined }
    ]);
    expect(stream.cancelled).toBe(true);
  });

  it.each(["error", "end", "close"] as const)(
    "rejects a pending write when the stream emits %s",
    async (event) => {
      const stream = new grpcMock.FakeStream();
      stream.autoCompleteWrites = false;
      grpcMock.queuedStreams.push(stream);
      const handlers = createHandlers();
      const transport = new GrpcAccountSubscriptionTransport(
        "http://localhost:10000"
      );
      await transport.connect(handlers, new AbortController().signal);

      const write = transport.setTrackedAccounts(["A1"], "confirmed");
      await vi.waitFor(() => expect(stream.writes).toHaveLength(1));
      const streamError = new Error("stream failed during write");
      if (event === "error") {
        stream.emit(event, streamError);
        await expect(write).rejects.toBe(streamError);
      } else {
        stream.emit(event);
        await expect(write).rejects.toThrow(`grpc stream ${event}`);
      }

      expect(handlers.onTransportError).toHaveBeenCalledTimes(1);
      await transport.close();
    }
  );

  it("reports a stream error once and ignores later terminal events", async () => {
    const stream = new grpcMock.FakeStream();
    grpcMock.queuedStreams.push(stream);
    const handlers = createHandlers();
    const transport = new GrpcAccountSubscriptionTransport("http://localhost:10000");
    await transport.connect(handlers, new AbortController().signal);

    const streamError = new Error("stream failed");
    stream.emit("error", streamError);
    stream.emit("end");
    stream.emit("close");

    expect(handlers.onTransportError).toHaveBeenCalledTimes(1);
    expect(handlers.onTransportError).toHaveBeenCalledWith(streamError);
    await transport.close();
  });
});
