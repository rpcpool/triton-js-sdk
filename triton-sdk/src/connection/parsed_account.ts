import { Buffer } from "buffer";
import { PublicKey, SYSVAR_CLOCK_PUBKEY, type AccountInfo, type DataSlice, type ParsedAccountData } from "@solana/web3.js";
import {
  AccountParseContextCache,
  InvalidAccountDataError,
  encodeAccount,
  getAccountMint,
  toWeb3JsParsedAccountInfo,
  type AccountEncodingInput,
  type AccountParseContext,
  type AccountParseContextFetcher
} from "../account_encoding";

const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Loads token context before asking the Solana decoder to encode the account. */
export async function parseConnectionAccount(
  input: AccountEncodingInput,
  fetcher: AccountParseContextFetcher,
  cache: AccountParseContextCache,
  dataSlice?: DataSlice
): Promise<AccountInfo<Buffer | ParsedAccountData>> {
  const mint = await getAccountMint(input);
  const parseContext = mint ? await loadContext(input, mint, fetcher, cache) : undefined;
  return toWeb3JsParsedAccountInfo(await encodeAccount(input, "jsonParsed", {
    parseContext,
    dataSlice
  }));
}

async function loadContext(
  input: AccountEncodingInput,
  mint: string,
  fetcher: AccountParseContextFetcher,
  cache: AccountParseContextCache
): Promise<AccountParseContext | undefined> {
  const token2022 = input.owner.toString() === TOKEN_2022_PROGRAM;
  const account = token2022
    ? await fetcher(new PublicKey(mint))
    : await cache.getOrLoad(mint, () => fetcher(new PublicKey(mint)));
  if (!account) return undefined;
  return {
    splTokenMint: { pubkey: mint, data: account.data },
    unixTimestamp: token2022 ? await loadClock(fetcher) : undefined
  };
}

async function loadClock(fetcher: AccountParseContextFetcher): Promise<number> {
  const clock = await fetcher(SYSVAR_CLOCK_PUBKEY);
  if (!clock) throw new InvalidAccountDataError("Clock account is unavailable");
  const data = typeof clock.data === "string"
    ? Buffer.from(clock.data, "base64")
    : Buffer.from(clock.data);
  if (data.length !== 40) throw new InvalidAccountDataError("Invalid Clock account data");
  const timestamp = Number(data.readBigInt64LE(32));
  if (!Number.isSafeInteger(timestamp)) throw new InvalidAccountDataError("Clock timestamp exceeds the safe integer range");
  return timestamp;
}
