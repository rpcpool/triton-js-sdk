import { beforeEach, describe, expect, it, vi } from "vitest";
import { Connection as BrowserConnection } from "../src/connection/browser_connection";
import { Connection as NodeConnection } from "../src/connection/node_connection";
import { AccountSyncTransports } from "../src/core/types";

const coreSpies = vi.hoisted(() => ({
  constructorSettings: vi.fn(),
}));

const transportSpies = vi.hoisted(() => ({
  wsConstructor: vi.fn(function MockWsAccountSubscriptionTransport(
    this: { endpoint: string; connectTimeoutMs: number },
    endpoint: string,
    _createSocket: unknown,
    connectTimeoutMs: number,
  ) {
    this.endpoint = endpoint;
    this.connectTimeoutMs = connectTimeoutMs;
  }),
  grpcConstructor: vi.fn(function MockGrpcAccountSubscriptionTransport(
    this: { endpoint: string; options: unknown },
    endpoint: string,
    options: unknown,
  ) {
    this.endpoint = endpoint;
    this.options = options;
  }),
}));

vi.mock("ws", () => ({
  default: vi.fn()
}));

vi.mock("../src/core/account_sync_core", () => {
  class MockAccountSyncCore {
    constructor(settings: unknown) {
      coreSpies.constructorSettings(settings);
    }
  }

  return { AccountSyncCore: MockAccountSyncCore };
});

vi.mock("../src/transport/ws", () => ({
  WsAccountSubscriptionTransport: transportSpies.wsConstructor
}));

vi.mock("../src/transport/grpc", () => ({
  GrpcAccountSubscriptionTransport: transportSpies.grpcConstructor
}));

interface CapturedAccountSyncCoreSettings {
  transportFactory: () => {
    endpoint: string;
    connectTimeoutMs?: number;
    options?: unknown;
  };
  closeTimeoutMs: number;
}

function lastCoreSettings(): CapturedAccountSyncCoreSettings {
  const settings = coreSpies.constructorSettings.mock.calls.at(-1)?.[0];
  if (!settings) {
    throw new Error("expected AccountSyncCore constructor settings");
  }

  return settings as CapturedAccountSyncCoreSettings;
}

function createCapturedTransport(): {
  endpoint: string;
  connectTimeoutMs?: number;
  options?: unknown;
} {
  return lastCoreSettings().transportFactory();
}

describe("Connection account-sync endpoint defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("node websocket transport receives the derived rpc endpoint when subscriptionEndpoint is omitted", () => {
    new NodeConnection("https://api.example.com/yourToken", {
      wsEndpoint: "ws://ignored.example.com/legacy",
      accountSync: { transport: AccountSyncTransports.WS }
    });

    expect(createCapturedTransport().endpoint).toBe(
      "wss://api.example.com/yourToken"
    );
  });

  it("browser websocket transport receives the derived rpc endpoint when subscriptionEndpoint is omitted", () => {
    new BrowserConnection("https://api.example.com/yourToken", {
      wsEndpoint: "ws://ignored.example.com/legacy",
      accountSync: { transport: AccountSyncTransports.WS }
    });

    expect(createCapturedTransport().endpoint).toBe(
      "wss://api.example.com/yourToken"
    );
  });

  it("node grpc transport receives the rpc endpoint when subscriptionEndpoint is omitted", () => {
    new NodeConnection("https://api.example.com/yourToken", {
      accountSync: { transport: AccountSyncTransports.GRPC }
    });

    expect(createCapturedTransport().endpoint).toBe(
      "https://api.example.com/yourToken"
    );
  });

  it("explicit subscriptionEndpoint overrides derived defaults", () => {
    new NodeConnection("https://api.example.com/rpcToken", {
      accountSync: {
        transport: AccountSyncTransports.GRPC,
        subscriptionEndpoint: "https://subscriptions.example.com/subscriptionToken"
      }
    });

    expect(createCapturedTransport().endpoint).toBe(
      "https://subscriptions.example.com/subscriptionToken"
    );
  });

  it("passes lifecycle timeouts to the websocket transport and core", () => {
    new NodeConnection("https://example.com", {
      accountSync: {
        connectTimeoutMs: 321,
        closeTimeoutMs: 654
      }
    });

    expect(createCapturedTransport().connectTimeoutMs).toBe(321);
    expect(lastCoreSettings().closeTimeoutMs).toBe(654);
  });

  it("passes fixed grpc-js channel defaults to the grpc transport", () => {
    new NodeConnection("https://example.com/token", {
      accountSync: { transport: AccountSyncTransports.GRPC }
    });

    expect(createCapturedTransport().options).toEqual({
      flowControlWindowBytes: 16 * 1024 * 1024,
      maxReceiveMessageLengthBytes: 16 * 1024 * 1024,
      keepAliveIntervalMs: 30_000,
      keepAliveTimeoutMs: 10_000,
      keepAlivePermitWithoutCalls: true
    });
  });

  it("rejects grpc settings when the node websocket transport is selected", () => {
    expect(
      () =>
        new NodeConnection("https://example.com", {
          accountSync: {
            transport: AccountSyncTransports.WS,
            grpc: { flowControlWindowBytes: 1024 }
          } as never
        })
    ).toThrow(/requires the grpc transport/);
  });

  it("rejects grpc settings in the browser build", () => {
    expect(
      () =>
        new BrowserConnection("https://example.com", {
          accountSync: {
            transport: AccountSyncTransports.WS,
            grpc: { flowControlWindowBytes: 1024 }
          } as never
        })
    ).toThrow(/does not support accountSync.grpc/);
  });
});
