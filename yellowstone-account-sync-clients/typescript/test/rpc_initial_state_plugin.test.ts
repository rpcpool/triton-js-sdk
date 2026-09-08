import { Buffer } from "buffer";
import { SolanaJSONRPCError } from "@solana/web3.js";
import dotenv from "dotenv";
import { describe, expect, it, vi } from "vitest";
import type { InitialStateHydrationContext } from "../src/core/initial_state_plugin";
import type { DecodedAccountUpdate } from "../src/core/types";
import {
  RpcInitialStateFetchError,
  RpcInitialStatePlugin
} from "../src/plugins/rpc_initial_state";

dotenv.config({ quiet: true });

interface FetchCall {
  url: string;
  body: unknown;
}

function makeContext(
  accountIds: readonly string[],
  upsert: (update: DecodedAccountUpdate) => boolean = () => true,
  remove: (accountId: string, slot: bigint) => boolean = () => true,
  minContextSlot?: number
): InitialStateHydrationContext {
  return {
    accountIds,
    commitment: "finalized",
    minContextSlot,
    signal: new AbortController().signal,
    upsert,
    remove
  };
}

function makeFetch(
  calls: FetchCall[],
  valueForAccounts: (accountIds: readonly string[]) => unknown[]
): typeof fetch {
  return (async (url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      params: [string[], { commitment: string; encoding: string }];
    };
    calls.push({ url: String(url), body });

    return {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: "2.0",
        id: body.params[0].length,
        result: {
          context: { slot: 123 },
          value: valueForAccounts(body.params[0])
        }
      })
    } as Response;
  }) as typeof fetch;
}

function makeResponseFetch(response: Response): typeof fetch {
  return (async () => response) as typeof fetch;
}

function makeJsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload
  } as Response;
}

describe("RpcInitialStatePlugin", () => {
  const testEndpoint = "https://unit.test/token";

  it("fetches getMultipleAccounts in base64 chunks of 100", async () => {
    const calls: FetchCall[] = [];
    const accountIds = Array.from({ length: 101 }, (_, index) => `A${index}`);
    const plugin = new RpcInitialStatePlugin({
      endpoint: testEndpoint,
      fetch: makeFetch(calls, (ids) => ids.map(() => null))
    });

    await plugin.hydrate(makeContext(accountIds));

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(testEndpoint);
    expect((calls[0].body as { method: string }).method).toBe("getMultipleAccounts");
    expect(
      (calls[0].body as { params: [string[], { encoding: string }] }).params[0]
    ).toHaveLength(100);
    expect(
      (calls[1].body as { params: [string[], { encoding: string }] }).params[0]
    ).toHaveLength(1);
    expect(
      (calls[0].body as { params: [string[], { encoding: string }] }).params[1]
        .encoding
    ).toBe("base64");
    expect(
      (calls[0].body as { params: [string[], { commitment: string }] }).params[1]
        .commitment
    ).toBe("finalized");
  });

  it("passes minContextSlot to RPC", async () => {
    const calls: FetchCall[] = [];
    const plugin = new RpcInitialStatePlugin({
      endpoint: testEndpoint,
      fetch: makeFetch(calls, () => [null])
    });

    await plugin.hydrate(makeContext(["A1"], () => true, () => true, 456));

    expect(
      (calls[0].body as { params: [string[], { minContextSlot: number }] })
        .params[1].minContextSlot
    ).toBe(456);
  });

  it("maps rounded u64 max JSON-RPC numbers back to u64 max", async () => {
    const upsert = vi.fn(() => true);
    const plugin = new RpcInitialStatePlugin({
      endpoint: testEndpoint,
      fetch: makeFetch([], () => [
        {
          lamports: 42,
          owner: "11111111111111111111111111111111",
          executable: false,
          rentEpoch: Number((1n << 64n) - 1n),
          data: [Buffer.from([1, 2, 3]).toString("base64"), "base64"]
        }
      ])
    });

    await plugin.hydrate(makeContext(["A1"], upsert));

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        rentEpoch: (1n << 64n) - 1n
      })
    );
  });

  it("decodes base64 account data into buffered updates", async () => {
    const calls: FetchCall[] = [];
    const upsert = vi.fn(() => true);
    const plugin = new RpcInitialStatePlugin({
      endpoint: testEndpoint,
      fetch: makeFetch(calls, () => [
        {
          lamports: "42",
          owner: "11111111111111111111111111111111",
          executable: false,
          rentEpoch: "18446744073709551615",
          data: [Buffer.from([1, 2, 3]).toString("base64"), "base64"]
        }
      ])
    });

    await plugin.hydrate(makeContext(["A1"], upsert));

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith({
      accountId: "A1",
      lamports: 42n,
      owner: "11111111111111111111111111111111",
      executable: false,
      rentEpoch: 18446744073709551615n,
      data: new Uint8Array([1, 2, 3]),
      slot: 123n,
      writeVersion: -1n
    });
  });

  it("skips null account entries", async () => {
    const calls: FetchCall[] = [];
    const upsert = vi.fn(() => true);
    const plugin = new RpcInitialStatePlugin({
      endpoint: testEndpoint,
      fetch: makeFetch(calls, () => [null])
    });

    await plugin.hydrate(makeContext(["A1"], upsert));

    expect(upsert).not.toHaveBeenCalled();
  });

  it("removes accounts observed as null at the RPC context slot", async () => {
    const remove = vi.fn(() => true);
    const plugin = new RpcInitialStatePlugin({
      endpoint: testEndpoint,
      fetch: makeFetch([], () => [null])
    });

    await plugin.hydrate(makeContext(["A1"], () => true, remove));

    expect(remove).toHaveBeenCalledWith("A1", 123n);
  });

  it("rejects HTTP failures like web3.js", async () => {
    const plugin = new RpcInitialStatePlugin({
      endpoint: testEndpoint,
      fetch: makeResponseFetch({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: async () => "try later"
      } as Response)
    });

    await expect(plugin.hydrate(makeContext(["A1"]))).rejects.toThrow(
      "503 Service Unavailable: try later"
    );
  });

  it("preserves JSON-RPC errors as SolanaJSONRPCError", async () => {
    const plugin = new RpcInitialStatePlugin({
      endpoint: testEndpoint,
      fetch: makeResponseFetch(
        makeJsonResponse({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32016,
            message: "Minimum context slot has not been reached",
            data: { contextSlot: 100 }
          }
        })
      )
    });

    const error = await plugin.hydrate(makeContext(["A1"])).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(SolanaJSONRPCError);
    expect(error).toMatchObject({
      name: "SolanaJSONRPCError",
      code: -32016,
      data: { contextSlot: 100 }
    });
  });

  it("rejects malformed result.value with a stable error", async () => {
    const plugin = new RpcInitialStatePlugin({
      endpoint: testEndpoint,
      fetch: makeResponseFetch(
        makeJsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            context: { slot: 123 },
            value: "not-an-array"
          }
        })
      )
    });

    await expect(plugin.hydrate(makeContext(["A1"]))).rejects.toThrow(
      RpcInitialStateFetchError
    );
    await expect(plugin.hydrate(makeContext(["A1"]))).rejects.toThrow(
      /missing result\.value/
    );
  });

  it("rejects account count mismatches with a stable error", async () => {
    const plugin = new RpcInitialStatePlugin({
      endpoint: testEndpoint,
      fetch: makeResponseFetch(
        makeJsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            context: { slot: 123 },
            value: [null]
          }
        })
      )
    });

    await expect(plugin.hydrate(makeContext(["A1", "A2"]))).rejects.toThrow(
      RpcInitialStateFetchError
    );
    await expect(plugin.hydrate(makeContext(["A1", "A2"]))).rejects.toThrow(
      /account count mismatch/
    );
  });
});
