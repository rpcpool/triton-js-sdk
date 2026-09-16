import { Buffer } from "buffer";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  PublicKey,
  type AccountInfo,
  type ParsedAccountData
} from "@solana/web3.js";
import {
  AccountParseContextCache,
  InvalidAccountDataError,
  UnsupportedEncodingError,
  convertAccountData,
  encodeAccount,
  loadAccountEncodingWasm,
  parseJsonParsed,
  toWeb3JsParsedAccountInfo,
  type AccountDataEncoding,
  type EncodedAccountData,
  type AccountEncodingInput
} from "../src/account_encoding";
import { parseConnectionAccount } from "../src/connection/parsed_account";

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
type RawAccountEncoding = Exclude<AccountDataEncoding, "jsonParsed">;
const RAW_ACCOUNT_ENCODINGS: readonly RawAccountEncoding[] = [
  "binary",
  "base58",
  "base64",
  "base64+zstd"
];

describe("account encoding wasm wrapper", () => {
  beforeAll(async () => {
    await loadAccountEncodingWasm();
  });

  it("encodes account data as base64", async () => {
    const input = makeAccountInput(Buffer.from([1, 2, 3]));

    const account = await encodeAccount(input, "base64");

    expect(account.data).toEqual(["AQID", "base64"]);
    expect(account.owner).toBe("11111111111111111111111111111111");
    expect(account.space).toBe(3);
  });

  it.each(RAW_ACCOUNT_ENCODINGS)(
    "encodes account data and metadata as %s",
    async (encoding) => {
      const data = Buffer.from([1, 2, 3, 4, 5]);
      const input = makeAccountInput(data);

      const account = await encodeAccount(input, encoding);

      expect(account.lamports).toBe(10);
      expect(account.owner).toBe(PublicKey.default.toBase58());
      expect(account.executable).toBe(false);
      expect(account.rentEpoch).toBe(0);
      expect(account.space).toBe(data.length);
      await expectEncodedDataBytes(account.data, encoding, data);
    }
  );

  it("round-trips base64, base58, binary, and base64+zstd data", async () => {
    const base64 = Buffer.from([1, 2, 3, 4, 5, 6]).toString("base64");

    const base58 = await convertAccountData(base64, "base64", "base58");
    expect(await convertAccountData(base58, "base58", "base64")).toBe(base64);

    const binary = await convertAccountData(base64, "base64", "binary");
    expect(binary).toBe(base58);
    expect(await convertAccountData(binary, "binary", "base64")).toBe(base64);

    const zstd = await convertAccountData(base64, "base64", "base64+zstd");
    expect(await convertAccountData(zstd, "base64+zstd", "base64")).toBe(base64);
  });

  it.each(RAW_ACCOUNT_ENCODINGS)(
    "applies dataSlice before %s encoding",
    async (encoding) => {
      const data = Buffer.from([1, 2, 3, 4, 5]);
      const input = makeAccountInput(data);

      const account = await encodeAccount(input, encoding, {
        dataSlice: { offset: 1, length: 3 }
      });

      await expectEncodedDataBytes(account.data, encoding, Buffer.from([2, 3, 4]));
    }
  );

  it("maps conversion errors to stable TS error classes", async () => {
    await expect(
      convertAccountData("not base64", "base64", "base58")
    ).rejects.toBeInstanceOf(InvalidAccountDataError);

    await expect(
      convertAccountData("{}", "jsonParsed", "base64")
    ).rejects.toBeInstanceOf(UnsupportedEncodingError);
  });

  it("rejects invalid account pubkey and owner inputs as typed errors", async () => {
    await expect(
      encodeAccount(
        {
          ...makeAccountInput(Buffer.from([1])),
          pubkey: "not a pubkey"
        },
        "base64"
      )
    ).rejects.toMatchObject({
      name: "InvalidAccountDataError",
      message: "invalid account pubkey",
      encoding: "base64"
    });

    await expect(
      encodeAccount(
        {
          ...makeAccountInput(Buffer.from([1])),
          owner: "not an owner"
        },
        "base64"
      )
    ).rejects.toMatchObject({
      name: "InvalidAccountDataError",
      message: "invalid account owner",
      encoding: "base64"
    });
  });

  it("rejects invalid base64 account data sent as a string", async () => {
    await expect(
      encodeAccount(
        {
          ...makeAccountInput(Buffer.from([1])),
          data: "not base64!"
        },
        "base64"
      )
    ).rejects.toMatchObject({
      name: "InvalidAccountDataError",
      encoding: "base64"
    });
  });

  it("rejects invalid jsonParsed account inputs", async () => {
    await expect(
      encodeAccount(
        {
          ...makeAccountInput(Buffer.from([1])),
          data: "not base64!"
        },
        "jsonParsed"
      )
    ).rejects.toMatchObject({
      name: "InvalidAccountDataError",
      encoding: "jsonParsed"
    });

    const mint = pubkeyFromByte(21);
    const tokenOwner = pubkeyFromByte(22);
    await expect(
      encodeAccount(makeTokenAccountInput(mint, tokenOwner), "jsonParsed", {
        parseContext: {
          splTokenMint: {
            pubkey: mint,
            data: "not base64!"
          }
        }
      })
    ).rejects.toMatchObject({
      name: "InvalidAccountDataError",
      encoding: "jsonParsed"
    });
  });

  it("rejects unsafe, negative, and out-of-range account numeric fields", async () => {
    await expect(
      encodeAccount(
        {
          ...makeAccountInput(Buffer.from([1])),
          lamports: Number.MAX_SAFE_INTEGER + 1
        },
        "base64"
      )
    ).rejects.toMatchObject({
      name: "InvalidAccountDataError",
      message: "lamports must be a safe integer when provided as a number"
    });

    await expect(
      encodeAccount(
        {
          ...makeAccountInput(Buffer.from([1])),
          lamports: -1n
        },
        "base64"
      )
    ).rejects.toMatchObject({
      name: "InvalidAccountDataError",
      message: "lamports must fit in u64"
    });

    await expect(
      encodeAccount(
        {
          ...makeAccountInput(Buffer.from([1])),
          lamports: "18446744073709551616"
        },
        "base64"
      )
    ).rejects.toMatchObject({
      name: "InvalidAccountDataError",
      message: "lamports must fit in u64"
    });

    await expect(
      encodeAccount(
        {
          ...makeAccountInput(Buffer.from([1])),
          rentEpoch: "not a number"
        },
        "base64"
      )
    ).rejects.toMatchObject({
      name: "InvalidAccountDataError",
      message: "rentEpoch must be an unsigned integer"
    });
  });

  it("rejects invalid dataSlice options before calling WASM", async () => {
    await expect(
      encodeAccount(makeAccountInput(Buffer.from([1, 2, 3])), "base64", {
        dataSlice: { offset: -1, length: 1 }
      })
    ).rejects.toMatchObject({
      name: "InvalidAccountDataError",
      message: "dataSlice offset and length must be non-negative safe integers"
    });

    await expect(
      encodeAccount(makeAccountInput(Buffer.from([1, 2, 3])), "base64", {
        dataSlice: { offset: 0, length: Number.MAX_SAFE_INTEGER + 1 }
      })
    ).rejects.toMatchObject({
      name: "InvalidAccountDataError",
      message: "dataSlice offset and length must be non-negative safe integers"
    });
  });

  it("rejects unsupported runtime encoding values", async () => {
    await expect(
      encodeAccount(
        makeAccountInput(Buffer.from([1])),
        "base32" as never
      )
    ).rejects.toBeInstanceOf(UnsupportedEncodingError);

    await expect(
      convertAccountData("AQID", "base64", "base32" as never)
    ).rejects.toBeInstanceOf(UnsupportedEncodingError);
  });

  it("rejects invalid encoded data for each raw conversion source", async () => {
    await expect(
      convertAccountData("not base64!", "base64", "base58")
    ).rejects.toMatchObject({
      name: "InvalidAccountDataError",
      encoding: "base58"
    });

    await expect(
      convertAccountData("0", "base58", "base64")
    ).rejects.toMatchObject({
      name: "InvalidAccountDataError",
      encoding: "base64"
    });

    await expect(
      convertAccountData("0", "binary", "base64")
    ).rejects.toMatchObject({
      name: "InvalidAccountDataError",
      encoding: "base64"
    });

    await expect(
      convertAccountData("not zstd", "base64+zstd", "base64")
    ).rejects.toMatchObject({
      name: "InvalidAccountDataError",
      encoding: "base64"
    });
  });

  it("rejects jsonParsed as either raw conversion side", async () => {
    await expect(
      convertAccountData("{}", "jsonParsed", "base64")
    ).rejects.toMatchObject({
      name: "UnsupportedEncodingError",
      encoding: "base64"
    });

    await expect(
      convertAccountData("AQID", "base64", "jsonParsed")
    ).rejects.toMatchObject({
      name: "UnsupportedEncodingError",
      encoding: "jsonParsed"
    });
  });

  it("reports missing SPL token mint context for strict jsonParsed parsing", async () => {
    const mint = pubkeyFromByte(9);
    const tokenOwner = pubkeyFromByte(10);
    const input = makeTokenAccountInput(mint, tokenOwner);

    await expect(parseJsonParsed(input)).rejects.toMatchObject({
      name: "MissingParseContextError",
      missingAccounts: [mint.toBase58()],
      contextKind: "splTokenMint"
    });
  });

  it("rejects invalid jsonParsed context values", async () => {
    const mint = pubkeyFromByte(15);
    const tokenOwner = pubkeyFromByte(16);
    const input = makeTokenAccountInput(mint, tokenOwner);

    await expect(
      parseJsonParsed(input, {
        unixTimestamp: Number.MAX_SAFE_INTEGER + 1
      })
    ).rejects.toMatchObject({
      name: "InvalidAccountDataError",
      message: "unixTimestamp must be a safe integer when provided"
    });

    await expect(
      parseJsonParsed(input, {
        parseContext: {
          splTokenMint: {
            pubkey: "not a mint",
            data: makeMintData(6)
          }
        }
      })
    ).rejects.toMatchObject({
      name: "InvalidAccountDataError",
      message: "invalid SPL token mint pubkey",
      encoding: "jsonParsed"
    });

    await expect(
      parseJsonParsed(input, {
        parseContext: {
          splTokenMint: {
            pubkey: mint,
            data: "not base64!"
          }
        }
      })
    ).rejects.toMatchObject({
      name: "InvalidAccountDataError",
      encoding: "jsonParsed"
    });
  });

  it("reports connection context fetch failures with their cause", async () => {
    const mint = pubkeyFromByte(17);
    const tokenOwner = pubkeyFromByte(18);
    const input = makeTokenAccountInput(mint, tokenOwner);
    const cause = new Error("fetch failed");
    const fetcher = vi.fn(async () => { throw cause; });

    await expect(
      parseConnectionAccount(input, fetcher, new AccountParseContextCache())
    ).rejects.toMatchObject({
      name: "ContextFetchError",
      cause,
      missingAccount: mint.toBase58(),
      contextKind: "splTokenMint",
      encoding: "jsonParsed"
    });
    await expect(
      parseConnectionAccount(input, async () => null, new AccountParseContextCache())
    ).rejects.toMatchObject({
      name: "ContextFetchError",
      message: `parse context account ${mint.toBase58()} is unavailable`,
      missingAccount: mint.toBase58()
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a connection parse when fetched mint data is invalid", async () => {
    const mint = pubkeyFromByte(19);
    const tokenOwner = pubkeyFromByte(20);
    const input = makeTokenAccountInput(mint, tokenOwner);

    const fetcher = vi.fn(async () => ({ data: Buffer.from([1]) }));
    await expect(
      parseConnectionAccount(input, fetcher, new AccountParseContextCache())
    ).rejects.toMatchObject({ name: "WasmParserError", encoding: "jsonParsed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fetches missing mint context once and re-runs jsonParsed parsing", async () => {
    const mint = pubkeyFromByte(11);
    const tokenOwner = pubkeyFromByte(12);
    const input = makeTokenAccountInput(mint, tokenOwner);
    const cache = new AccountParseContextCache({ maxEntries: 8, ttlMs: 10_000 });
    const fetcher = vi.fn(async (_pubkey: PublicKey) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return makeTokenMintAccountInfo(makeMintData(6));
    });

    const [parsedA, parsedB] = await Promise.all([
      parseConnectionAccount(input, fetcher, cache),
      parseConnectionAccount(input, fetcher, cache)
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(parsedA).toEqual(parsedB);
    expect(parsedA.data.program).toBe("spl-token");
    expect(parsedA.data.parsed.type).toBe("account");
    expect(parsedA.data.parsed.info.mint).toBe(mint.toBase58());
    expect(parsedA.data.parsed.info.tokenAmount.decimals).toBe(6);
  });

  it("encodes SPL token accounts as jsonParsed when mint context is provided", async () => {
    const mint = pubkeyFromByte(25);
    const tokenOwner = pubkeyFromByte(26);
    const input = makeTokenAccountInput(mint, tokenOwner);

    const account = await encodeAccount(input, "jsonParsed", {
      parseContext: {
        splTokenMint: {
          pubkey: mint,
          data: makeMintData(6)
        }
      }
    });
    const parsed = expectParsedAccountData(account.data);
    const info = parsed.parsed.info as {
      mint: string;
      owner: string;
      tokenAmount: { amount: string; decimals: number };
    };

    expect(account.owner).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect(parsed.program).toBe("spl-token");
    expect(parsed.parsed.type).toBe("account");
    expect(info.mint).toBe(mint.toBase58());
    expect(info.owner).toBe(tokenOwner.toBase58());
    expect(info.tokenAmount.amount).toBe("500");
    expect(info.tokenAmount.decimals).toBe(6);
  });

  it("rejects jsonParsed encoding when context is unavailable", async () => {
    const mint = pubkeyFromByte(13);
    const tokenOwner = pubkeyFromByte(14);
    const input = makeTokenAccountInput(mint, tokenOwner);

    await expect(encodeAccount(input, "jsonParsed")).rejects.toMatchObject({
      name: "MissingParseContextError",
      missingAccounts: [mint.toBase58()],
      contextKind: "splTokenMint"
    });
  });

  it.each(["encode", "parse"] as const)("%s rejects unsupported programs and malformed accounts", async (method) => {
    const run = method === "encode"
      ? (input: AccountEncodingInput) => encodeAccount(input, "jsonParsed")
      : parseJsonParsed;
    for (const owner of [pubkeyFromByte(99), TOKEN_PROGRAM_ID]) {
      await expect(run({ ...makeAccountInput(Buffer.from([1])), owner }))
        .rejects.toMatchObject({ name: "WasmParserError", encoding: "jsonParsed" });
    }
  });

  it.each(["encode", "parse"] as const)("%s rejects invalid WASM JSON without retrying", async (method) => {
    const realWasm = await loadAccountEncodingWasm();
    const invalidJson = vi.fn(() => "not JSON");
    const wasm = { ...realWasm, encode_account: invalidJson, parse_account_json: invalidJson };
    const input = makeAccountInput(Buffer.from([1]));
    const result = method === "encode"
      ? encodeAccount(input, "jsonParsed", { wasm })
      : parseJsonParsed(input, { wasm });
    await expect(result).rejects.toMatchObject({
      name: "WasmParserError", message: "WASM returned invalid JSON", cause: expect.any(SyntaxError)
    });
    expect(invalidJson).toHaveBeenCalledTimes(1);
  });

  it("returns the same parsed data from both helpers and ignores dataSlice", async () => {
    const input = makeTokenAccountInput(pubkeyFromByte(11), pubkeyFromByte(12));
    const options = {
      parseContext: { splTokenMint: { pubkey: pubkeyFromByte(11), data: makeMintData(6) } },
      dataSlice: { offset: 0, length: 0 }
    };
    const parsed = await parseJsonParsed(input, options);
    const encoded = await encodeAccount(input, "jsonParsed", options);
    expect(encoded.data).toEqual(parsed);
    expect(parsed.parsed.info.tokenAmount.decimals).toBe(6);
    expect(encoded.space).toBe(165);
    expect(encoded.lamports).toBe(2_039_280);
  });

  it("rejects raw data in the parsed account adapter", async () => {
    const raw = await encodeAccount(makeAccountInput(Buffer.from([1])), "base64");
    expect(() => toWeb3JsParsedAccountInfo(raw)).toThrow(UnsupportedEncodingError);
  });

  it("evicts old cache entries by LRU order", () => {
    const cache = new AccountParseContextCache({ maxEntries: 1, ttlMs: 10_000 });
    const first = pubkeyFromByte(21);
    const second = pubkeyFromByte(22);

    cache.set(first, { data: Buffer.from([1]) });
    expect(cache.get(first)?.data).toEqual(Buffer.from([1]));
    cache.set(second, { data: Buffer.from([2]) });

    expect(cache.get(first)).toBeUndefined();
    expect(cache.get(second)?.data).toEqual(Buffer.from([2]));
  });

  it("expires cache entries by TTL", async () => {
    const accountId = pubkeyFromByte(23);
    const cache = new AccountParseContextCache({ maxEntries: 8, ttlMs: 1 });
    const loader = vi
      .fn<() => Promise<{ data: Buffer }>>()
      .mockResolvedValueOnce({ data: Buffer.from([1]) })
      .mockResolvedValueOnce({ data: Buffer.from([2]) });

    expect(await cache.getOrLoad(accountId, loader)).toEqual({
      data: Buffer.from([1])
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(await cache.getOrLoad(accountId, loader)).toEqual({
      data: Buffer.from([2])
    });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("removes rejected in-flight cache loads so callers can retry", async () => {
    const accountId = pubkeyFromByte(24);
    const cache = new AccountParseContextCache({ maxEntries: 8, ttlMs: 10_000 });
    const loader = vi
      .fn<() => Promise<{ data: Buffer }>>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ data: Buffer.from([9]) });

    await expect(cache.getOrLoad(accountId, loader)).rejects.toThrow(
      "temporary failure"
    );
    await expect(cache.getOrLoad(accountId, loader)).resolves.toEqual({
      data: Buffer.from([9])
    });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("does not restore a deleted entry from an old in-flight load", async () => {
    const accountId = pubkeyFromByte(27);
    const cache = new AccountParseContextCache({ maxEntries: 8, ttlMs: 10_000 });
    let releaseLoad: (() => void) | undefined;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });

    const oldLoad = cache.getOrLoad(accountId, async () => {
      await loadGate;
      return { data: Buffer.from([1]) };
    });
    cache.delete(accountId);
    const newLoad = cache.getOrLoad(accountId, async () => ({
      data: Buffer.from([2])
    }));
    releaseLoad?.();

    await expect(oldLoad).resolves.toEqual({ data: Buffer.from([1]) });
    await expect(newLoad).resolves.toEqual({ data: Buffer.from([2]) });
    expect(cache.get(accountId)).toEqual({ data: Buffer.from([2]) });
  });
});

async function expectEncodedDataBytes(
  data: EncodedAccountData,
  expectedEncoding: RawAccountEncoding,
  expectedBytes: Buffer
): Promise<void> {
  const base64 = await encodedDataToBase64(data, expectedEncoding);

  expect(Buffer.from(base64, "base64")).toEqual(expectedBytes);
}

async function encodedDataToBase64(
  data: EncodedAccountData,
  expectedEncoding: RawAccountEncoding
): Promise<string> {
  if (expectedEncoding === "binary") {
    expect(typeof data).toBe("string");
    if (typeof data !== "string") {
      throw new Error("expected binary encoding to return a data string");
    }

    return convertAccountData(data, "binary", "base64");
  }

  const [encoded, actualEncoding] = expectEncodedDataTuple(data);
  expect(actualEncoding).toBe(expectedEncoding);

  if (actualEncoding === "base64") {
    return encoded;
  }

  return convertAccountData(encoded, actualEncoding, "base64");
}

function expectEncodedDataTuple(
  data: EncodedAccountData
): [string, RawAccountEncoding] {
  expect(Array.isArray(data)).toBe(true);
  if (!Array.isArray(data)) {
    throw new Error("expected account data tuple");
  }

  const [encoded, encoding] = data;
  expect(typeof encoded).toBe("string");
  expect(isRawAccountEncoding(encoding)).toBe(true);

  if (typeof encoded !== "string" || !isRawAccountEncoding(encoding)) {
    throw new Error("expected encoded account data tuple");
  }

  return [encoded, encoding];
}

function isRawAccountEncoding(value: unknown): value is RawAccountEncoding {
  return RAW_ACCOUNT_ENCODINGS.includes(value as RawAccountEncoding);
}

function expectParsedAccountData(data: EncodedAccountData): ParsedAccountData {
  expect(typeof data).toBe("object");
  expect(data).not.toBeNull();
  expect(Array.isArray(data)).toBe(false);

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("expected parsed account data");
  }

  return data;
}

function makeAccountInput(data: Buffer): AccountEncodingInput {
  return {
    pubkey: pubkeyFromByte(1),
    owner: PublicKey.default,
    lamports: 10n,
    executable: false,
    rentEpoch: 0n,
    data
  };
}

function makeTokenAccountInput(
  mint: PublicKey,
  tokenOwner: PublicKey
): AccountEncodingInput {
  return {
    pubkey: pubkeyFromByte(2),
    owner: TOKEN_PROGRAM_ID,
    lamports: 2_039_280n,
    executable: false,
    rentEpoch: 0n,
    data: makeTokenAccountData(mint, tokenOwner)
  };
}

function makeTokenAccountData(mint: PublicKey, tokenOwner: PublicKey): Buffer {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  tokenOwner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(500n, 64);
  data[108] = 1;
  return data;
}

function makeMintData(decimals: number): Buffer {
  const data = Buffer.alloc(82);
  data.writeBigUInt64LE(1_000_000n, 36);
  data[44] = decimals;
  data[45] = 1;
  return data;
}

function makeTokenMintAccountInfo(data: Buffer): AccountInfo<Buffer> {
  return {
    executable: false,
    owner: TOKEN_PROGRAM_ID,
    lamports: 1_461_600,
    data,
    rentEpoch: 0
  };
}

function pubkeyFromByte(byte: number): PublicKey {
  return new PublicKey(Buffer.alloc(32, byte));
}
