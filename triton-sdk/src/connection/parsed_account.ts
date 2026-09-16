import { PublicKey, type AccountInfo, type ParsedAccountData } from "@solana/web3.js";
import {
  AccountParseContextCache,
  ContextFetchError,
  MissingParseContextError,
  encodeAccount,
  toWeb3JsParsedAccountInfo,
  type AccountEncodingInput,
  type AccountParseContextAccount,
  type AccountParseContextFetcher
} from "../account_encoding";

/** Parses an account, loading a missing mint through the connection once. */
export async function parseConnectionAccount(
  input: AccountEncodingInput,
  fetcher: AccountParseContextFetcher,
  cache: AccountParseContextCache
): Promise<AccountInfo<ParsedAccountData>> {
  try {
    return toWeb3JsParsedAccountInfo(await encodeAccount(input, "jsonParsed"));
  } catch (error) {
    if (!(error instanceof MissingParseContextError)) {
      throw error;
    }
    const mint = error.missingAccounts[0];
    if (!mint || error.contextKind !== "splTokenMint") {
      throw error;
    }
    const account = await loadMint(mint, error, fetcher, cache);
    return toWeb3JsParsedAccountInfo(await encodeAccount(input, "jsonParsed", {
      parseContext: { splTokenMint: { pubkey: mint, data: account.data } }
    }));
  }
}

async function loadMint(
  mint: string,
  error: MissingParseContextError,
  fetcher: AccountParseContextFetcher,
  cache: AccountParseContextCache
): Promise<AccountParseContextAccount> {
  const metadata = {
    pubkey: error.pubkey,
    owner: error.owner,
    encoding: error.encoding,
    missingAccount: mint,
    contextKind: error.contextKind
  };
  let account: AccountParseContextAccount | null;
  try {
    account = await cache.getOrLoad(mint, () => fetcher(new PublicKey(mint)));
  } catch (cause) {
    throw new ContextFetchError(`failed to fetch parse context account ${mint}`, {
      ...metadata,
      cause
    });
  }
  if (!account) {
    throw new ContextFetchError(`parse context account ${mint} is unavailable`, metadata);
  }
  return account;
}
