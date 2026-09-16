import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSyncConnection as NodeConnection } from "../src/connection/node_connection";
import { AccountSyncConnection as BrowserConnection } from "../src/connection/browser_connection";
import type { AccountBufferObservation } from "../src/core/account_buffer";

const reads = vi.hoisted(() => ({ one: vi.fn(), many: vi.fn() }));
vi.mock("../src/core/account_sync_core", () => ({
  AccountSyncCore: class {
    getBufferedAccountObservation = reads.one;
    getBufferedAccountObservations = reads.many;
  }
}));

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const mintKey = new PublicKey(Buffer.alloc(32, 9));
const tokenKey = new PublicKey(Buffer.alloc(32, 10));
const missing: AccountBufferObservation = {
  kind: "missing", tombstone: { slot: 90n, writeVersion: 0n }
};

describe.each([
  ["Node", NodeConnection],
  ["browser", BrowserConnection]
] as const)("%s parsed account reads", (_name, Connection) => {
  beforeEach(() => { vi.resetAllMocks(); });

  it("returns parsed data and fetches the mint with the same read constraints", async () => {
    const connection = new Connection("https://example.com", { accountSync: {} });
    reads.one.mockResolvedValueOnce(tokenObservation()).mockResolvedValueOnce(mintObservation());

    const result = await connection.getParsedAccountInfo(tokenKey, {
      commitment: "finalized", minContextSlot: 95, dataSlice: { offset: 0, length: 0 }
    });

    expect(result.context.slot).toBe(100);
    expect(result.value?.data.parsed.info.tokenAmount.decimals).toBe(6);
    expect(reads.one).toHaveBeenNthCalledWith(2, mintKey.toBase58(), "finalized", { minContextSlot: 95 });
    expect(reads.one).toHaveBeenCalledTimes(2);
  });

  it("preserves order, duplicates, missing accounts, and the lowest slot", async () => {
    const connection = new Connection("https://example.com", { accountSync: {} });
    reads.many.mockResolvedValue([tokenObservation(), missing, mintObservation(), tokenObservation()]);
    reads.one.mockResolvedValue(mintObservation());

    const result = await connection.getMultipleParsedAccounts([tokenKey, PublicKey.default, mintKey, tokenKey]);

    expect(result.context.slot).toBe(90);
    expect(result.value[0]?.data.parsed.type).toBe("account");
    expect(result.value[1]).toBeNull();
    expect(result.value[2]?.data.parsed.type).toBe("mint");
    expect(result.value[3]).toEqual(result.value[0]);
    expect(reads.one).toHaveBeenCalledTimes(1);
  });

  it("returns null for a missing single account", async () => {
    const connection = new Connection("https://example.com", { accountSync: {} });
    reads.one.mockResolvedValue(missing);
    await expect(connection.getParsedAccountInfo(tokenKey)).resolves.toEqual({
      context: { slot: 90 }, value: null
    });
    expect(reads.one).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported data without loading context", async () => {
    const connection = new Connection("https://example.com", { accountSync: {} });
    reads.one.mockResolvedValue(observation(tokenKey, Buffer.from([1]), PublicKey.default.toBase58()));
    await expect(connection.getParsedAccountInfo(tokenKey)).rejects.toMatchObject({ name: "WasmParserError" });
    expect(reads.one).toHaveBeenCalledTimes(1);
  });

  it("rejects the entire batch when an account cannot be parsed", async () => {
    const connection = new Connection("https://example.com", { accountSync: {} });
    reads.many.mockResolvedValue([
      mintObservation(), observation(tokenKey, Buffer.from([1]), TOKEN_PROGRAM)
    ]);
    await expect(connection.getMultipleParsedAccounts([mintKey, tokenKey]))
      .rejects.toMatchObject({ name: "WasmParserError" });
    expect(reads.one).not.toHaveBeenCalled();
  });

  it("rejects a read when the mint is missing", async () => {
    const connection = new Connection("https://example.com", { accountSync: {} });
    reads.one.mockResolvedValueOnce(tokenObservation()).mockResolvedValueOnce(missing);
    await expect(connection.getParsedAccountInfo(tokenKey)).rejects.toMatchObject({
      name: "ContextFetchError", missingAccount: mintKey.toBase58()
    });
    expect(reads.one).toHaveBeenCalledTimes(2);
  });

  it("rejects a read when loading the mint fails", async () => {
    const connection = new Connection("https://example.com", { accountSync: {} });
    reads.one.mockResolvedValueOnce(tokenObservation()).mockRejectedValueOnce(new Error("read failed"));
    await expect(connection.getParsedAccountInfo(tokenKey)).rejects.toMatchObject({
      name: "ContextFetchError", cause: expect.any(Error)
    });
    expect(reads.one).toHaveBeenCalledTimes(2);
  });
});

function observation(pubkey: PublicKey, data: Buffer, owner: string): AccountBufferObservation {
  return {
    kind: "account",
    state: {
      accountId: pubkey.toBase58(), owner, data, lamports: 10n,
      executable: false, rentEpoch: 0n, slot: 100n, writeVersion: 0n, updatedAtMs: 0
    }
  };
}

function tokenObservation(): AccountBufferObservation {
  const data = Buffer.alloc(165);
  mintKey.toBuffer().copy(data, 0);
  tokenKey.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(500n, 64);
  data[108] = 1;
  return observation(tokenKey, data, TOKEN_PROGRAM);
}

function mintObservation(): AccountBufferObservation {
  const data = Buffer.alloc(82);
  data[44] = 6;
  data[45] = 1;
  return observation(mintKey, data, TOKEN_PROGRAM);
}
