import { Buffer } from "buffer";
import {
  PublicKey,
  type AccountInfo,
  type DataSlice,
  type ParsedAccountData
} from "@solana/web3.js";
import initAccountEncodingWasm, {
  convert_account_data,
  encode_account,
  parse_account_json,
  WasmUiAccountEncoding
} from "./wasm/account_encoding/yellowstone_account_sync_account_encoding_wasm.js";
import type { BufferedAccountState } from "./core/types";

export type AccountDataEncoding =
  | "binary"
  | "base58"
  | "base64"
  | "base64+zstd"
  | "jsonParsed";

export type EncodedAccountData =
  | string
  | [string, Exclude<AccountDataEncoding, "jsonParsed">]
  | ParsedAccountData;

export interface UiAccount {
  lamports: number;
  data: EncodedAccountData;
  owner: string;
  executable: boolean;
  rentEpoch: number;
  space?: number;
}

export interface AccountEncodingInput {
  pubkey: string | PublicKey;
  owner: string | PublicKey;
  lamports: number | bigint | string;
  executable: boolean;
  rentEpoch: number | bigint | string;
  data: Uint8Array | Buffer | string;
}

export interface AccountParseContextMint {
  pubkey: string | PublicKey;
  data: Uint8Array | Buffer | string;
}

export interface AccountParseContext {
  splTokenMint?: AccountParseContextMint;
  unixTimestamp?: number;
}

export interface AccountParseContextAccount {
  data: Uint8Array | Buffer | string;
}

export type AccountParseContextFetcher = (
  pubkey: PublicKey
) => Promise<AccountInfo<Buffer> | AccountParseContextAccount | null>;

export interface AccountEncodingOptions {
  dataSlice?: DataSlice;
  parseContext?: AccountParseContext;
  parseContextFetcher?: AccountParseContextFetcher;
  cache?: AccountParseContextCache;
  fallbackOnParseFailure?: boolean;
  unixTimestamp?: number;
  /** @internal Allows tests to inject a parser without changing global WASM state. */
  wasm?: AccountEncodingWasm;
}

export interface ConvertAccountDataOptions {
  /** @internal Allows tests to inject a parser without changing global WASM state. */
  wasm?: AccountEncodingWasm;
}

export interface AccountEncodingErrorMetadata {
  pubkey?: string;
  owner?: string;
  encoding?: AccountDataEncoding;
  cause?: unknown;
}

export class UnsupportedEncodingError extends Error {
  readonly pubkey?: string;
  readonly owner?: string;
  readonly encoding?: AccountDataEncoding;
  readonly cause?: unknown;

  constructor(message: string, metadata: AccountEncodingErrorMetadata = {}) {
    super(message);
    this.name = "UnsupportedEncodingError";
    this.pubkey = metadata.pubkey;
    this.owner = metadata.owner;
    this.encoding = metadata.encoding;
    this.cause = metadata.cause;
  }
}

export class InvalidAccountDataError extends Error {
  readonly pubkey?: string;
  readonly owner?: string;
  readonly encoding?: AccountDataEncoding;
  readonly cause?: unknown;

  constructor(message: string, metadata: AccountEncodingErrorMetadata = {}) {
    super(message);
    this.name = "InvalidAccountDataError";
    this.pubkey = metadata.pubkey;
    this.owner = metadata.owner;
    this.encoding = metadata.encoding;
    this.cause = metadata.cause;
  }
}

export class MissingParseContextError extends Error {
  readonly pubkey?: string;
  readonly owner?: string;
  readonly encoding?: AccountDataEncoding;
  readonly missingAccounts: readonly string[];
  readonly contextKind?: string;
  readonly cause?: unknown;

  constructor(
    message: string,
    metadata: AccountEncodingErrorMetadata & {
      missingAccounts?: readonly string[];
      contextKind?: string;
    } = {}
  ) {
    super(message);
    this.name = "MissingParseContextError";
    this.pubkey = metadata.pubkey;
    this.owner = metadata.owner;
    this.encoding = metadata.encoding;
    this.missingAccounts = metadata.missingAccounts ?? [];
    this.contextKind = metadata.contextKind;
    this.cause = metadata.cause;
  }
}

export class ContextFetchError extends Error {
  readonly pubkey?: string;
  readonly owner?: string;
  readonly encoding?: AccountDataEncoding;
  readonly missingAccount?: string;
  readonly contextKind?: string;
  readonly cause?: unknown;

  constructor(
    message: string,
    metadata: AccountEncodingErrorMetadata & {
      missingAccount?: string;
      contextKind?: string;
    } = {}
  ) {
    super(message);
    this.name = "ContextFetchError";
    this.pubkey = metadata.pubkey;
    this.owner = metadata.owner;
    this.encoding = metadata.encoding;
    this.missingAccount = metadata.missingAccount;
    this.contextKind = metadata.contextKind;
    this.cause = metadata.cause;
  }
}

export class WasmParserError extends Error {
  readonly pubkey?: string;
  readonly owner?: string;
  readonly encoding?: AccountDataEncoding;
  readonly cause?: unknown;

  constructor(message: string, metadata: AccountEncodingErrorMetadata = {}) {
    super(message);
    this.name = "WasmParserError";
    this.pubkey = metadata.pubkey;
    this.owner = metadata.owner;
    this.encoding = metadata.encoding;
    this.cause = metadata.cause;
  }
}

export interface AccountParseContextCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
}

interface CacheEntry {
  value: AccountParseContextAccount | null;
  expiresAtMs: number;
}

export class AccountParseContextCache {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<
    string,
    Promise<AccountParseContextAccount | null>
  >();
  private readonly inFlightTokens = new Map<string, object>();

  constructor(options: AccountParseContextCacheOptions = {}) {
    this.maxEntries = validatePositiveInteger(
      options.maxEntries ?? 256,
      "maxEntries"
    );
    this.ttlMs = validatePositiveInteger(options.ttlMs ?? 300_000, "ttlMs");
  }

  get(pubkey: string | PublicKey): AccountParseContextAccount | null | undefined {
    const key = normalizePubkey(pubkey);
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAtMs <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(
    pubkey: string | PublicKey,
    value: AccountParseContextAccount | null
  ): void {
    const key = normalizePubkey(pubkey);
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      expiresAtMs: Date.now() + this.ttlMs
    });
    this.evictOldest();
  }

  async getOrLoad(
    pubkey: string | PublicKey,
    loader: () => Promise<AccountParseContextAccount | null>
  ): Promise<AccountParseContextAccount | null> {
    const key = normalizePubkey(pubkey);
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const token = {};
    const inFlight = loader().then((value) => {
      if (this.inFlightTokens.get(key) === token) {
        this.set(key, value);
      }
      return value;
    });
    this.inFlight.set(key, inFlight);
    this.inFlightTokens.set(key, token);

    try {
      return await inFlight;
    } finally {
      if (this.inFlight.get(key) === inFlight) {
        this.inFlight.delete(key);
      }
      if (this.inFlightTokens.get(key) === token) {
        this.inFlightTokens.delete(key);
      }
    }
  }

  delete(pubkey: string | PublicKey): boolean {
    const key = normalizePubkey(pubkey);
    this.inFlight.delete(key);
    this.inFlightTokens.delete(key);
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.inFlightTokens.clear();
  }

  private evictOldest(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.entries.delete(oldest);
    }
  }
}

export interface AccountEncodingWasm {
  encode_account(
    accountJson: string,
    encoding: WasmUiAccountEncoding,
    contextJson?: string | null,
    dataSliceJson?: string | null
  ): string;
  parse_account_json(accountJson: string, contextJson?: string | null): string;
  convert_account_data(
    input: string,
    from: WasmUiAccountEncoding,
    to: WasmUiAccountEncoding
  ): string;
}

interface NormalizedAccountInput {
  pubkey: string;
  owner: string;
  lamports: string;
  executable: boolean;
  rentEpoch: string;
  data: string;
  dataBytes: Buffer;
}

interface WasmErrorPayload {
  code?: string;
  message?: string;
  pubkey?: string;
  owner?: string;
  encoding?: AccountDataEncoding;
  missingContext?: {
    missingAccounts?: string[];
    contextKind?: string;
  };
}

const WASM_FILE_URL = new URL(
  "./wasm/account_encoding/yellowstone_account_sync_account_encoding_wasm_bg.wasm",
  import.meta.url
);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const U64_MAX = (1n << 64n) - 1n;

let wasmInitPromise: Promise<AccountEncodingWasm> | undefined;

export function isBase64ZstdEncodingSupported(): boolean {
  return true;
}

export async function loadAccountEncodingWasm(): Promise<AccountEncodingWasm> {
  if (!wasmInitPromise) {
    wasmInitPromise = initializeWasm();
  }

  return wasmInitPromise;
}

export async function encodeAccount(
  input: AccountEncodingInput,
  encoding: AccountDataEncoding,
  options: AccountEncodingOptions = {}
): Promise<UiAccount> {
  const normalizedEncoding = normalizeEncoding(encoding);
  const account = normalizeAccountInput(input, normalizedEncoding);
  const wasm = options.wasm ?? (await loadAccountEncodingWasm());

  if (normalizedEncoding !== "jsonParsed") {
    try {
      return parseWasmJson<UiAccount>(
        wasm.encode_account(
          accountPayloadJson(account),
          toWasmEncoding(normalizedEncoding),
          null,
          dataSliceJson(options.dataSlice)
        )
      );
    } catch (error) {
      throw mapWasmError(error, {
        pubkey: account.pubkey,
        owner: account.owner,
        encoding: normalizedEncoding
      });
    }
  }

  const fallbackOnParseFailure = options.fallbackOnParseFailure ?? true;
  return runWithParseContext<UiAccount>(
    account,
    normalizedEncoding,
    options,
    (contextJson) =>
      parseWasmJson<UiAccount>(
        wasm.encode_account(
          accountPayloadJson(account),
          WasmUiAccountEncoding.JsonParsed,
          contextJson,
          dataSliceJson(options.dataSlice)
        )
      ),
    () => buildJsonParsedFallback(account, options.dataSlice),
    fallbackOnParseFailure
  );
}

export async function parseJsonParsed(
  input: AccountEncodingInput,
  options: AccountEncodingOptions = {}
): Promise<ParsedAccountData | [string, "base64"]> {
  const account = normalizeAccountInput(input, "jsonParsed");
  const wasm = options.wasm ?? (await loadAccountEncodingWasm());
  const fallbackOnParseFailure = options.fallbackOnParseFailure ?? false;

  return runWithParseContext<ParsedAccountData | [string, "base64"]>(
    account,
    "jsonParsed",
    options,
    (contextJson) =>
      parseWasmJson<ParsedAccountData>(
        wasm.parse_account_json(accountPayloadJson(account), contextJson)
      ),
    () => [account.data, "base64"],
    fallbackOnParseFailure
  );
}

export async function convertAccountData(
  input: string,
  from: AccountDataEncoding,
  to: AccountDataEncoding,
  options: ConvertAccountDataOptions = {}
): Promise<string> {
  const fromEncoding = normalizeEncoding(from);
  const toEncoding = normalizeEncoding(to);
  if (fromEncoding === "jsonParsed" || toEncoding === "jsonParsed") {
    throw new UnsupportedEncodingError(
      "jsonParsed account data cannot be converted as raw bytes",
      { encoding: toEncoding }
    );
  }

  const wasm = options.wasm ?? (await loadAccountEncodingWasm());
  try {
    return wasm.convert_account_data(
      input,
      toWasmEncoding(fromEncoding),
      toWasmEncoding(toEncoding)
    );
  } catch (error) {
    throw mapWasmError(error, { encoding: toEncoding });
  }
}

export function bufferedAccountToEncodingInput(
  state: BufferedAccountState
): AccountEncodingInput {
  return {
    pubkey: state.accountId,
    owner: state.owner,
    lamports: state.lamports,
    executable: state.executable,
    rentEpoch: state.rentEpoch,
    data: state.data
  };
}

export function accountInfoToEncodingInput(
  pubkey: string | PublicKey,
  accountInfo: AccountInfo<Buffer>
): AccountEncodingInput {
  return {
    pubkey,
    owner: accountInfo.owner,
    lamports: accountInfo.lamports,
    executable: accountInfo.executable,
    rentEpoch: accountInfo.rentEpoch ?? 0,
    data: accountInfo.data
  };
}

export function toWeb3JsParsedAccountInfo(
  account: UiAccount
): AccountInfo<Buffer | ParsedAccountData> {
  return {
    executable: account.executable,
    owner: new PublicKey(account.owner),
    lamports: account.lamports,
    data: toWeb3JsParsedAccountData(account.data, {
      owner: account.owner,
      encoding: "jsonParsed"
    }),
    rentEpoch: account.rentEpoch
  };
}

async function initializeWasm(): Promise<AccountEncodingWasm> {
  await initAccountEncodingWasm({ module_or_path: await resolveWasmInitInput() });
  return {
    encode_account,
    parse_account_json,
    convert_account_data
  };
}

async function resolveWasmInitInput(): Promise<URL | Buffer> {
  if (!isNodeRuntime()) {
    return WASM_FILE_URL;
  }

  const [{ readFile }, { fileURLToPath }] = await Promise.all([
    import("node:fs/promises"),
    import("node:url")
  ]);
  return readFile(fileURLToPath(WASM_FILE_URL));
}

function isNodeRuntime(): boolean {
  return (
    typeof process !== "undefined" &&
    typeof process.versions === "object" &&
    typeof process.versions.node === "string"
  );
}

async function runWithParseContext<T>(
  account: NormalizedAccountInput,
  encoding: AccountDataEncoding,
  options: AccountEncodingOptions,
  run: (contextJson: string | null) => T,
  fallback: () => T,
  fallbackOnParseFailure: boolean
): Promise<T> {
  const baseContext = normalizeParseContext(options);
  try {
    return run(contextJson(baseContext));
  } catch (error) {
    const mapped = mapWasmError(error, {
      pubkey: account.pubkey,
      owner: account.owner,
      encoding
    });
    if (!(mapped instanceof MissingParseContextError)) {
      if (fallbackOnParseFailure && shouldFallbackOnJsonParsedError(mapped)) {
        return fallback();
      }
      throw mapped;
    }

    const resolvedContext = await resolveMissingParseContext(
      mapped,
      options,
      account,
      encoding,
      baseContext,
      fallbackOnParseFailure
    );
    if (!resolvedContext) {
      return fallback();
    }

    try {
      return run(contextJson(resolvedContext));
    } catch (retryError) {
      const mappedRetry = mapWasmError(retryError, {
        pubkey: account.pubkey,
        owner: account.owner,
        encoding
      });
      if (fallbackOnParseFailure && shouldFallbackOnJsonParsedError(mappedRetry)) {
        return fallback();
      }
      throw mappedRetry;
    }
  }
}

function shouldFallbackOnJsonParsedError(error: Error): boolean {
  return (
    error instanceof MissingParseContextError ||
    error instanceof ContextFetchError ||
    error instanceof WasmParserError
  );
}

async function resolveMissingParseContext(
  error: MissingParseContextError,
  options: AccountEncodingOptions,
  account: NormalizedAccountInput,
  encoding: AccountDataEncoding,
  baseContext: AccountParseContext | undefined,
  fallbackOnParseFailure: boolean
): Promise<AccountParseContext | undefined> {
  const missingAccount = error.missingAccounts[0];
  if (!missingAccount || error.contextKind !== "splTokenMint") {
    if (fallbackOnParseFailure) {
      return undefined;
    }
    throw error;
  }

  if (!options.parseContextFetcher) {
    if (fallbackOnParseFailure) {
      return undefined;
    }
    throw error;
  }

  let fetched: AccountParseContextAccount | null;
  try {
    const load = () => fetchParseContextAccount(missingAccount, options);
    fetched = options.cache
      ? await options.cache.getOrLoad(missingAccount, load)
      : await load();
  } catch (cause) {
    const fetchError = new ContextFetchError(
      `failed to fetch parse context account ${missingAccount}`,
      {
        pubkey: account.pubkey,
        owner: account.owner,
        encoding,
        missingAccount,
        contextKind: error.contextKind,
        cause
      }
    );
    if (fallbackOnParseFailure) {
      return undefined;
    }
    throw fetchError;
  }

  if (!fetched) {
    const fetchError = new ContextFetchError(
      `parse context account ${missingAccount} is unavailable`,
      {
        pubkey: account.pubkey,
        owner: account.owner,
        encoding,
        missingAccount,
        contextKind: error.contextKind
      }
    );
    if (fallbackOnParseFailure) {
      return undefined;
    }
    throw fetchError;
  }

  return {
    ...baseContext,
    splTokenMint: {
      pubkey: missingAccount,
      data: contextDataToBase64(fetched.data)
    }
  };
}

async function fetchParseContextAccount(
  pubkey: string,
  options: AccountEncodingOptions
): Promise<AccountParseContextAccount | null> {
  if (!options.parseContextFetcher) {
    return null;
  }

  const account = await options.parseContextFetcher(new PublicKey(pubkey));
  if (!account) {
    return null;
  }

  return {
    data: account.data
  };
}

function normalizeAccountInput(
  input: AccountEncodingInput,
  encoding: AccountDataEncoding
): NormalizedAccountInput {
  const pubkey = normalizePubkeyOrThrow(input.pubkey, "account pubkey", {
    encoding
  });
  const owner = normalizePubkeyOrThrow(input.owner, "account owner", {
    pubkey,
    encoding
  });
  const dataBytes =
    typeof input.data === "string" ? Buffer.from(input.data, "base64") : toBuffer(input.data);
  return {
    pubkey,
    owner,
    lamports: toU64String(input.lamports, "lamports", { pubkey, owner, encoding }),
    executable: input.executable,
    rentEpoch: toU64String(input.rentEpoch, "rentEpoch", {
      pubkey,
      owner,
      encoding
    }),
    data: typeof input.data === "string" ? input.data : dataBytes.toString("base64"),
    dataBytes
  };
}

function normalizeParseContext(
  options: AccountEncodingOptions
): AccountParseContext | undefined {
  const source = options.parseContext;
  const unixTimestamp = options.unixTimestamp ?? source?.unixTimestamp;
  const normalized: AccountParseContext = {};

  if (source?.splTokenMint) {
    normalized.splTokenMint = {
      pubkey: normalizePubkeyOrThrow(source.splTokenMint.pubkey, "SPL token mint pubkey", {
        encoding: "jsonParsed"
      }),
      data: contextDataToBase64(source.splTokenMint.data)
    };
  }

  if (unixTimestamp !== undefined) {
    if (!Number.isSafeInteger(unixTimestamp)) {
      throw new InvalidAccountDataError(
        "unixTimestamp must be a safe integer when provided",
        { encoding: "jsonParsed" }
      );
    }
    normalized.unixTimestamp = unixTimestamp;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function accountPayloadJson(account: NormalizedAccountInput): string {
  return JSON.stringify({
    pubkey: account.pubkey,
    owner: account.owner,
    lamports: account.lamports,
    executable: account.executable,
    rentEpoch: account.rentEpoch,
    data: account.data
  });
}

function contextDataToBase64(data: Uint8Array | Buffer | string): string {
  return typeof data === "string" ? data : toBuffer(data).toString("base64");
}

function contextJson(context: AccountParseContext | undefined): string | null {
  return context ? JSON.stringify(context) : null;
}

function dataSliceJson(dataSlice: DataSlice | undefined): string | null {
  if (!dataSlice) {
    return null;
  }

  if (
    !Number.isSafeInteger(dataSlice.offset) ||
    dataSlice.offset < 0 ||
    !Number.isSafeInteger(dataSlice.length) ||
    dataSlice.length < 0
  ) {
    throw new InvalidAccountDataError(
      "dataSlice offset and length must be non-negative safe integers"
    );
  }

  return JSON.stringify({
    offset: dataSlice.offset,
    length: dataSlice.length
  });
}

function buildJsonParsedFallback(
  account: NormalizedAccountInput,
  dataSlice: DataSlice | undefined
): UiAccount {
  return {
    lamports: toUiNumber(account.lamports),
    data: [sliceBytes(account.dataBytes, dataSlice).toString("base64"), "base64"],
    owner: account.owner,
    executable: account.executable,
    rentEpoch: toUiNumber(account.rentEpoch),
    space: account.dataBytes.length
  };
}

function sliceBytes(data: Buffer, dataSlice: DataSlice | undefined): Buffer {
  if (!dataSlice) {
    return data;
  }

  const end =
    dataSlice.length > Number.MAX_SAFE_INTEGER - dataSlice.offset
      ? Number.MAX_SAFE_INTEGER
      : dataSlice.offset + dataSlice.length;
  return data.subarray(dataSlice.offset, end);
}

function normalizeEncoding(encoding: AccountDataEncoding): AccountDataEncoding {
  switch (encoding) {
    case "binary":
    case "base58":
    case "base64":
    case "base64+zstd":
    case "jsonParsed":
      return encoding;
    default:
      throw new UnsupportedEncodingError(
        `unsupported account encoding '${String(encoding)}'`,
        { encoding }
      );
  }
}

function toWasmEncoding(encoding: AccountDataEncoding): WasmUiAccountEncoding {
  switch (encoding) {
    case "binary":
      return WasmUiAccountEncoding.Binary;
    case "base58":
      return WasmUiAccountEncoding.Base58;
    case "base64":
      return WasmUiAccountEncoding.Base64;
    case "base64+zstd":
      return WasmUiAccountEncoding.Base64Zstd;
    case "jsonParsed":
      return WasmUiAccountEncoding.JsonParsed;
  }
}

function mapWasmError(
  error: unknown,
  metadata: AccountEncodingErrorMetadata
): Error {
  if (
    error instanceof UnsupportedEncodingError ||
    error instanceof InvalidAccountDataError ||
    error instanceof MissingParseContextError ||
    error instanceof ContextFetchError ||
    error instanceof WasmParserError
  ) {
    return error;
  }

  const payload = parseWasmErrorPayload(error);
  const message = payload?.message ?? errorMessage(error);
  const common = {
    pubkey: payload?.pubkey ?? metadata.pubkey,
    owner: payload?.owner ?? metadata.owner,
    encoding: payload?.encoding ?? metadata.encoding,
    cause: error
  };

  switch (payload?.code) {
    case "INVALID_ACCOUNT_DATA":
      return new InvalidAccountDataError(message, common);
    case "MISSING_PARSE_CONTEXT":
      return new MissingParseContextError(message, {
        ...common,
        missingAccounts: payload.missingContext?.missingAccounts ?? [],
        contextKind: payload.missingContext?.contextKind
      });
    case "WASM_PARSER_ERROR":
      return new WasmParserError(message, common);
    default:
      return new WasmParserError(message, common);
  }
}

function parseWasmErrorPayload(error: unknown): WasmErrorPayload | undefined {
  const message = errorMessage(error);
  try {
    const parsed = JSON.parse(message) as WasmErrorPayload;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseWasmJson<T>(json: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (cause) {
    throw new WasmParserError("WASM returned invalid JSON", { cause });
  }
}

function toWeb3JsParsedAccountData(
  data: EncodedAccountData,
  metadata: AccountEncodingErrorMetadata
): Buffer | ParsedAccountData {
  if (Array.isArray(data)) {
    const [value, encoding] = data;
    if (encoding !== "base64") {
      throw new UnsupportedEncodingError(
        `cannot convert ${encoding} account data into web3.js parsed AccountInfo`,
        metadata
      );
    }
    return Buffer.from(value, "base64");
  }

  if (typeof data === "string") {
    throw new UnsupportedEncodingError(
      "cannot convert legacy string account data into web3.js parsed AccountInfo",
      metadata
    );
  }

  return data;
}

function toBuffer(value: Uint8Array | Buffer): Buffer {
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }

  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function normalizePubkey(pubkey: string | PublicKey): string {
  if (typeof pubkey === "string") {
    return new PublicKey(pubkey).toBase58();
  }

  return pubkey.toBase58();
}

function normalizePubkeyOrThrow(
  pubkey: string | PublicKey,
  fieldName: string,
  metadata: AccountEncodingErrorMetadata
): string {
  try {
    return normalizePubkey(pubkey);
  } catch (cause) {
    throw new InvalidAccountDataError(`invalid ${fieldName}`, {
      ...metadata,
      cause
    });
  }
}

function toU64String(
  value: number | bigint | string,
  fieldName: string,
  metadata: AccountEncodingErrorMetadata
): string {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new InvalidAccountDataError(
        `${fieldName} must be a safe integer when provided as a number`,
        metadata
      );
    }
    parsed = BigInt(value);
  } else {
    if (!/^\d+$/.test(value)) {
      throw new InvalidAccountDataError(`${fieldName} must be an unsigned integer`, {
        ...metadata,
        cause: value
      });
    }
    parsed = BigInt(value);
  }

  if (parsed < 0n || parsed > U64_MAX) {
    throw new InvalidAccountDataError(`${fieldName} must fit in u64`, metadata);
  }

  return parsed.toString();
}

function toUiNumber(value: string): number {
  const parsed = BigInt(value);
  if (parsed > MAX_SAFE_BIGINT) {
    return Number.MAX_SAFE_INTEGER;
  }

  return Number(parsed);
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }

  return value;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
