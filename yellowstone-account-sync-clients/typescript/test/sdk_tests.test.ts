import { describe, expect, it } from "vitest";
import {
  resolveAccountSyncSettings,
  resolveGetAccountInfoCommitment,
  resolveGetAccountInfoOptions,
  resolveGetMultipleAccountsInfoOptions
} from "../src/connection/utils";
import { AccountSyncTransports, type AccountSyncCommitment } from "../src/core/types";
import { SubscribeRequest } from "../src/generated/grpc/geyser";
import { createSubscribeRequest } from "../src/transport/protobuf";

function decodeCommitment(commitment: AccountSyncCommitment): number | undefined {
  const request = createSubscribeRequest(["A1"], commitment);
  const encoded = SubscribeRequest.encode(request).finish();
  const decoded = SubscribeRequest.decode(encoded);
  return decoded.commitment;
}

describe("commitment settings", () => {
  it("defaults SDK commitment to confirmed", () => {
    const resolved = resolveAccountSyncSettings(
      undefined,
      "ws://127.0.0.1:12000",
      AccountSyncTransports.WS,
      undefined
    );

    expect(resolved.commitment).toBe("confirmed");
  });

  it("uses constructor commitment when accountSync commitment is omitted", () => {
    const resolved = resolveAccountSyncSettings(
      undefined,
      "ws://127.0.0.1:12000",
      AccountSyncTransports.WS,
      "processed"
    );

    expect(resolved.commitment).toBe("processed");
  });

  it("lets accountSync commitment override constructor commitment", () => {
    const resolved = resolveAccountSyncSettings(
      { commitment: "finalized" },
      "ws://127.0.0.1:12000",
      AccountSyncTransports.WS,
      "processed"
    );

    expect(resolved.commitment).toBe("finalized");
  });
});

describe("reconnection settings", () => {
  it("uses stable polling and reconnect defaults", () => {
    const resolved = resolveAccountSyncSettings(
      undefined,
      "ws://127.0.0.1:12000",
      AccountSyncTransports.WS,
      undefined
    );

    expect(resolved.rpcPollIntervalMs).toBe(1_000);
    expect(resolved.reconnectInitialDelayMs).toBe(100);
    expect(resolved.reconnectMaxDelayMs).toBe(5_000);
    expect(resolved.connectTimeoutMs).toBe(10_000);
    expect(resolved.closeTimeoutMs).toBe(5_000);
    expect(resolved.dynamicSubscriptionTtlMs).toBe(60_000);
    expect(resolved.maxAccountsPerCommitment).toBe(10_000);
  });

  it("rejects invalid polling and reconnect delays", () => {
    expect(() =>
      resolveAccountSyncSettings(
        { rpcPollIntervalMs: 0 },
        "ws://127.0.0.1:12000",
        AccountSyncTransports.WS,
        undefined
      )
    ).toThrow(/rpcPollIntervalMs/);
    expect(() =>
      resolveAccountSyncSettings(
        { reconnectInitialDelayMs: 200, reconnectMaxDelayMs: 100 },
        "ws://127.0.0.1:12000",
        AccountSyncTransports.WS,
        undefined
      )
    ).toThrow(/reconnectMaxDelayMs/);
    expect(() =>
      resolveAccountSyncSettings(
        { connectTimeoutMs: 0 },
        "ws://127.0.0.1:12000",
        AccountSyncTransports.WS,
        undefined
      )
    ).toThrow(/connectTimeoutMs/);
    expect(() =>
      resolveAccountSyncSettings(
        { closeTimeoutMs: Number.NaN },
        "ws://127.0.0.1:12000",
        AccountSyncTransports.WS,
        undefined
      )
    ).toThrow(/closeTimeoutMs/);
    expect(() =>
      resolveAccountSyncSettings(
        { dynamicSubscriptionTtlMs: 0 },
        "ws://127.0.0.1:12000",
        AccountSyncTransports.WS,
        undefined
      )
    ).toThrow(/dynamicSubscriptionTtlMs/);
    expect(() =>
      resolveAccountSyncSettings(
        { maxAccountsPerCommitment: 0 },
        "ws://127.0.0.1:12000",
        AccountSyncTransports.WS,
        undefined
      )
    ).toThrow(/maxAccountsPerCommitment/);
  });
});

describe("grpc-js channel settings", () => {
  it("uses fixed window and keepalive defaults", () => {
    const resolved = resolveAccountSyncSettings(
      { transport: AccountSyncTransports.GRPC },
      "https://example.com/token",
      AccountSyncTransports.GRPC,
      undefined
    );

    expect(resolved.grpc).toEqual({
      flowControlWindowBytes: 16 * 1024 * 1024,
      maxReceiveMessageLengthBytes: 16 * 1024 * 1024,
      keepAliveIntervalMs: 30_000,
      keepAliveTimeoutMs: 10_000,
      keepAlivePermitWithoutCalls: true
    });
  });

  it("keeps explicit grpc stream settings", () => {
    const resolved = resolveAccountSyncSettings(
      {
        transport: AccountSyncTransports.GRPC,
        grpc: {
          flowControlWindowBytes: 8 * 1024 * 1024,
          maxReceiveMessageLengthBytes: 32 * 1024 * 1024,
          keepAliveIntervalMs: 20_000,
          keepAliveTimeoutMs: 5_000,
          keepAlivePermitWithoutCalls: false
        }
      },
      "https://example.com/token",
      AccountSyncTransports.GRPC,
      undefined
    );

    expect(resolved.grpc).toEqual({
      flowControlWindowBytes: 8 * 1024 * 1024,
      maxReceiveMessageLengthBytes: 32 * 1024 * 1024,
      keepAliveIntervalMs: 20_000,
      keepAliveTimeoutMs: 5_000,
      keepAlivePermitWithoutCalls: false
    });
  });

  it("rejects invalid grpc stream settings", () => {
    expect(() =>
      resolveAccountSyncSettings(
        {
          transport: AccountSyncTransports.GRPC,
          grpc: { flowControlWindowBytes: 0 }
        },
        "https://example.com/token",
        AccountSyncTransports.GRPC,
        undefined
      )
    ).toThrow(/flowControlWindowBytes/);
    expect(() =>
      resolveAccountSyncSettings(
        {
          transport: AccountSyncTransports.GRPC,
          grpc: { keepAliveIntervalMs: 0 }
        },
        "https://example.com/token",
        AccountSyncTransports.GRPC,
        undefined
      )
    ).toThrow(/keepAliveIntervalMs/);
  });
});

describe("getAccountInfo commitment syntax", () => {
  it("uses fallback commitment when getAccountInfo commitment is omitted", () => {
    expect(resolveGetAccountInfoCommitment(undefined, "confirmed")).toBe("confirmed");
  });

  it("uses string commitment argument", () => {
    expect(resolveGetAccountInfoCommitment("processed", "confirmed")).toBe(
      "processed"
    );
  });

  it("uses config object commitment argument", () => {
    expect(
      resolveGetAccountInfoCommitment({ commitment: "finalized" }, "confirmed")
    ).toBe("finalized");
  });

  it("rejects unsupported web3.js commitment values", () => {
    expect(() => resolveGetAccountInfoCommitment("max", "confirmed")).toThrow(
      /unsupported account-sync commitment/
    );
  });
});

describe("getAccountInfo config syntax", () => {
  it("uses fallback commitment when only dataSlice is provided", () => {
    const resolved = resolveGetAccountInfoOptions(
      { dataSlice: { offset: 2, length: 4 } },
      "confirmed"
    );

    expect(resolved).toEqual({
      commitment: "confirmed",
      dataSlice: { offset: 2, length: 4 },
      minContextSlot: undefined
    });
  });

  it("uses fallback commitment when only minContextSlot is provided", () => {
    const resolved = resolveGetAccountInfoOptions(
      { minContextSlot: 99 },
      "finalized"
    );

    expect(resolved).toEqual({
      commitment: "finalized",
      dataSlice: undefined,
      minContextSlot: 99
    });
  });

  it("keeps commitment, dataSlice, and minContextSlot from config", () => {
    const resolved = resolveGetAccountInfoOptions(
      {
        commitment: "processed",
        dataSlice: { offset: 1, length: 2 },
        minContextSlot: 7
      },
      "confirmed"
    );

    expect(resolved).toEqual({
      commitment: "processed",
      dataSlice: { offset: 1, length: 2 },
      minContextSlot: 7
    });
  });

  it("rejects invalid dataSlice values", () => {
    expect(() =>
      resolveGetAccountInfoOptions(
        { dataSlice: { offset: -1, length: 1 } },
        "confirmed"
      )
    ).toThrow(/dataSlice\.offset/);
    expect(() =>
      resolveGetAccountInfoOptions(
        { dataSlice: { offset: 0, length: 1.5 } },
        "confirmed"
      )
    ).toThrow(/dataSlice\.length/);
  });

  it("rejects invalid minContextSlot values", () => {
    expect(() =>
      resolveGetAccountInfoOptions({ minContextSlot: -1 }, "confirmed")
    ).toThrow(/minContextSlot/);
    expect(() =>
      resolveGetAccountInfoOptions({ minContextSlot: Number.NaN }, "confirmed")
    ).toThrow(/minContextSlot/);
  });
});

describe("getMultipleAccountsInfo config syntax", () => {
  it("keeps commitment, dataSlice, and minContextSlot from config", () => {
    const resolved = resolveGetMultipleAccountsInfoOptions(
      {
        commitment: "processed",
        dataSlice: { offset: 1, length: 2 },
        minContextSlot: 7
      },
      "confirmed"
    );

    expect(resolved).toEqual({
      commitment: "processed",
      dataSlice: { offset: 1, length: 2 },
      minContextSlot: 7
    });
  });

  it("rejects invalid config values with method-specific errors", () => {
    expect(() =>
      resolveGetMultipleAccountsInfoOptions(
        { dataSlice: { offset: -1, length: 1 } },
        "confirmed"
      )
    ).toThrow(/getMultipleAccountsInfo dataSlice\.offset/);
    expect(() =>
      resolveGetMultipleAccountsInfoOptions(
        { minContextSlot: Number.NaN },
        "confirmed"
      )
    ).toThrow(/getMultipleAccountsInfo minContextSlot/);
  });
});

describe("subscribe request commitment", () => {
  it("encodes processed commitment", () => {
    expect(decodeCommitment("processed")).toBe(0);
  });

  it("encodes confirmed commitment", () => {
    expect(decodeCommitment("confirmed")).toBe(1);
  });

  it("encodes finalized commitment", () => {
    expect(decodeCommitment("finalized")).toBe(2);
  });
});
