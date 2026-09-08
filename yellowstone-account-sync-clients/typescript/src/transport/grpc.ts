import {
  Metadata,
  type ChannelCredentials,
  type ChannelOptions,
  type ClientDuplexStream,
  credentials
} from "@grpc/grpc-js";
import type { AccountSubscriptionTransport, TransportHandlers } from "../core/transport";
import type {
  AccountSyncCommitment,
  GrpcTransportOptions
} from "../core/types";
import { YellowstoneAccountSyncGrpcServiceClient } from "../generated/grpc/account_sync";
import type { SubscribeRequest, SubscribeUpdate } from "../generated/grpc/geyser";
import { setsEqual } from "./common";
import {
  createSubscribeRequest,
  subscribeUpdateToAccountUpdate
} from "./protobuf";

const DEFAULT_FLOW_CONTROL_WINDOW_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RECEIVE_MESSAGE_LENGTH_BYTES = 16 * 1024 * 1024;
const DEFAULT_KEEP_ALIVE_INTERVAL_MS = 30_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 10_000;

interface ResolvedGrpcTransportOptions {
  flowControlWindowBytes: number;
  maxReceiveMessageLengthBytes: number;
  keepAliveIntervalMs: number;
  keepAliveTimeoutMs: number;
  keepAlivePermitWithoutCalls: boolean;
}

// What: gRPC transport implementation for account subscriptions.
// Why: Node users may prefer gRPC streaming instead of WebSocket.
// How: Uses the grpc-js client generated from account_sync.proto.
export class GrpcAccountSubscriptionTransport implements AccountSubscriptionTransport {
  private readonly endpoint: string;
  private readonly options: ResolvedGrpcTransportOptions;

  private handlers: TransportHandlers | null = null;
  private client: YellowstoneAccountSyncGrpcServiceClient | null = null;
  private stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate> | null =
    null;
  private streamGeneration = 0;
  private appliedAccountIds = new Set<string>();
  private appliedCommitment: AccountSyncCommitment | null = null;
  private operationChain: Promise<void> = Promise.resolve();
  private pendingWriteAbortController: AbortController | null = null;
  private closed = false;
  private intentionallyClosing = false;
  private lifecycleSignal: AbortSignal | null = null;

  constructor(endpoint: string, options: GrpcTransportOptions = {}) {
    if (typeof window !== "undefined") {
      throw new Error("gRPC transport is not supported in browsers");
    }

    this.endpoint = endpoint;
    this.options = resolveGrpcTransportOptions(options);
  }

  public async connect(
    handlers: TransportHandlers,
    signal: AbortSignal
  ): Promise<void> {
    throwIfAborted(signal);
    this.handlers = handlers;
    this.lifecycleSignal = signal;
    await this.enqueue(async () => {
      await this.ensureOpenStream();
    });
  }

  public async setTrackedAccounts(
    accountIds: readonly string[],
    commitment: AccountSyncCommitment
  ): Promise<void> {
    await this.enqueue(async () => {
      throwIfAborted(this.lifecycleSignal);
      const nextAccountIds = new Set(
        accountIds.filter((accountId) => accountId.length > 0)
      );
      if (
        setsEqual(nextAccountIds, this.appliedAccountIds) &&
        this.appliedCommitment === commitment
      ) {
        return;
      }

      await this.ensureOpenStream();
      const stream = this.stream;
      if (!stream) {
        throw new Error("grpc stream is not open");
      }
      const generation = this.streamGeneration;

      try {
        await this.writeSubscribeRequest(stream, nextAccountIds, commitment);
      } catch (error: unknown) {
        this.handleStreamFailure(stream, generation, toError(error), true);
        throw error;
      }

      if (
        this.closed ||
        this.stream !== stream ||
        this.streamGeneration !== generation
      ) {
        throw createAbortError("grpc stream changed during subscription write");
      }

      this.appliedAccountIds = nextAccountIds;
      this.appliedCommitment = commitment;
    });
  }

  public async close(): Promise<void> {
    if (this.closed) {
      await this.operationChain;
      return;
    }

    this.closed = true;
    this.intentionallyClosing = true;
    this.pendingWriteAbortController?.abort();
    this.pendingWriteAbortController = null;

    const activeStream = this.stream;
    this.stream = null;
    this.streamGeneration += 1;
    this.appliedAccountIds.clear();
    this.appliedCommitment = null;
    try {
      activeStream?.cancel();
    } catch {
      // Best effort. The local write wait was already aborted.
    }

    const activeClient = this.client;
    this.client = null;
    activeClient?.close();

    await this.enqueue(async () => {
      this.handlers = null;
    });
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationChain.then(operation, operation);
    this.operationChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async ensureOpenStream(): Promise<void> {
    if (this.closed) {
      throw new Error("grpc transport is closed");
    }
    throwIfAborted(this.lifecycleSignal);

    if (this.stream) {
      return;
    }

    const { target, channelCredentials, metadata } = normalizeGrpcEndpoint(
      this.endpoint
    );

    if (!this.client) {
      this.client = new YellowstoneAccountSyncGrpcServiceClient(
        target,
        channelCredentials,
        createChannelOptions(this.options)
      );
    }

    this.intentionallyClosing = false;
    const stream = this.client.subscribe(metadata);
    const generation = this.streamGeneration + 1;
    this.streamGeneration = generation;
    this.stream = stream;
    this.appliedAccountIds.clear();
    this.appliedCommitment = null;

    stream.on("data", (update) => {
      if (this.stream !== stream || this.streamGeneration !== generation) {
        return;
      }
      const accountUpdate = subscribeUpdateToAccountUpdate(update);
      if (accountUpdate) {
        this.handlers?.onAccountUpdate(accountUpdate);
      }
    });
    stream.on("error", (error) => {
      this.handleStreamFailure(stream, generation, error);
    });
    stream.on("end", () => {
      this.handleStreamFailure(stream, generation, new Error("grpc stream ended"));
    });
    stream.on("close", () => {
      this.handleStreamFailure(stream, generation, new Error("grpc stream closed"));
    });
  }

  private handleStreamFailure(
    stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>,
    generation: number,
    error: Error,
    cancelStream = false
  ): void {
    if (
      this.intentionallyClosing ||
      this.stream !== stream ||
      this.streamGeneration !== generation
    ) {
      return;
    }

    this.stream = null;
    this.streamGeneration += 1;
    this.appliedAccountIds.clear();
    this.appliedCommitment = null;
    if (cancelStream) {
      try {
        stream.cancel();
      } catch {
        // The failed write already made this stream unusable.
      }
    }
    this.handlers?.onTransportError(error);
  }

  private async writeSubscribeRequest(
    stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>,
    accountIds: ReadonlySet<string>,
    commitment: AccountSyncCommitment
  ): Promise<void> {
    const writeAbortController = new AbortController();
    this.pendingWriteAbortController = writeAbortController;
    const abortFromLifecycle = () => writeAbortController.abort();
    const lifecycleSignal = this.lifecycleSignal;
    if (lifecycleSignal?.aborted) {
      writeAbortController.abort();
    } else {
      lifecycleSignal?.addEventListener("abort", abortFromLifecycle, { once: true });
    }

    try {
      await waitForStreamWrite(
        stream,
        createSubscribeRequest([...accountIds], commitment),
        writeAbortController.signal
      );
    } finally {
      lifecycleSignal?.removeEventListener("abort", abortFromLifecycle);
      if (this.pendingWriteAbortController === writeAbortController) {
        this.pendingWriteAbortController = null;
      }
    }
  }
}

export function normalizeGrpcEndpoint(endpoint: string): {
  target: string;
  channelCredentials: ChannelCredentials;
  metadata: Metadata;
} {
  const isLocalEndpoint =
    endpoint.startsWith("localhost") ||
    endpoint.startsWith("127.0.0.1") ||
    endpoint.startsWith("[::1]") ||
    endpoint.startsWith("::1") ||
    endpoint.startsWith("0.0.0.0");
  const normalizedEndpoint = endpoint.includes("://")
    ? endpoint
    : isLocalEndpoint
      ? `http://${endpoint}`
      : `https://${endpoint}`;
  const url = new URL(normalizedEndpoint);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`invalid grpc endpoint protocol: ${url.protocol}`);
  }

  const target = url.port.length > 0 ? `${url.hostname}:${url.port}` : url.hostname;
  const channelCredentials =
    url.protocol === "https:" ? credentials.createSsl() : credentials.createInsecure();
  const pathSegments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const token = extractGrpcPathToken(pathSegments);
  const metadata = new Metadata();
  if (token) {
    metadata.set("x-token", token);
  }

  return { target, channelCredentials, metadata };
}

function extractGrpcPathToken(pathSegments: readonly string[]): string | null {
  if (pathSegments.length === 0) {
    return null;
  }

  if (pathSegments.length === 1) {
    return pathSegments[0];
  }

  throw new Error("invalid grpc endpoint path: expected no path or /<token>");
}

function createChannelOptions(options: ResolvedGrpcTransportOptions): ChannelOptions {
  return {
    "grpc-node.flow_control_window": options.flowControlWindowBytes,
    "grpc.max_receive_message_length": options.maxReceiveMessageLengthBytes,
    "grpc.keepalive_time_ms": options.keepAliveIntervalMs,
    "grpc.keepalive_timeout_ms": options.keepAliveTimeoutMs,
    "grpc.keepalive_permit_without_calls": options.keepAlivePermitWithoutCalls ? 1 : 0
  };
}

function resolveGrpcTransportOptions(
  options: GrpcTransportOptions
): ResolvedGrpcTransportOptions {
  return {
    flowControlWindowBytes: positiveInteger(
      options.flowControlWindowBytes,
      DEFAULT_FLOW_CONTROL_WINDOW_BYTES,
      "flowControlWindowBytes"
    ),
    maxReceiveMessageLengthBytes: positiveInteger(
      options.maxReceiveMessageLengthBytes,
      DEFAULT_MAX_RECEIVE_MESSAGE_LENGTH_BYTES,
      "maxReceiveMessageLengthBytes"
    ),
    keepAliveIntervalMs: positiveInteger(
      options.keepAliveIntervalMs,
      DEFAULT_KEEP_ALIVE_INTERVAL_MS,
      "keepAliveIntervalMs"
    ),
    keepAliveTimeoutMs: positiveInteger(
      options.keepAliveTimeoutMs,
      DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
      "keepAliveTimeoutMs"
    ),
    keepAlivePermitWithoutCalls: booleanValue(
      options.keepAlivePermitWithoutCalls,
      true,
      "keepAlivePermitWithoutCalls"
    )
  };
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`grpc ${name} must be a positive safe integer`);
  }
  return resolved;
}

function booleanValue(
  value: boolean | undefined,
  fallback: boolean,
  name: string
): boolean {
  const resolved = value ?? fallback;
  if (typeof resolved !== "boolean") {
    throw new Error(`grpc ${name} must be a boolean`);
  }
  return resolved;
}

function waitForStreamWrite(
  stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>,
  request: SubscribeRequest,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let callbackFinished = false;
    let drainSeen = false;
    let needsDrain: boolean | null = null;

    const cleanup = () => {
      signal.removeEventListener("abort", handleAbort);
      stream.off("drain", handleDrain);
      stream.off("error", handleError);
      stream.off("end", handleEnd);
      stream.off("close", handleClose);
    };
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const finishIfReady = () => {
      if (
        callbackFinished &&
        needsDrain !== null &&
        (!needsDrain || drainSeen)
      ) {
        finish();
      }
    };
    const handleAbort = () => finish(createAbortError());
    const handleDrain = () => {
      drainSeen = true;
      finishIfReady();
    };
    const handleError = (error: Error) => finish(error);
    const handleEnd = () => finish(new Error("grpc stream ended during write"));
    const handleClose = () => finish(new Error("grpc stream closed during write"));

    signal.addEventListener("abort", handleAbort, { once: true });
    stream.on("drain", handleDrain);
    stream.on("error", handleError);
    stream.on("end", handleEnd);
    stream.on("close", handleClose);

    try {
      const accepted = stream.write(
        request,
        (error: Error | null | undefined) => {
          if (error) {
            finish(error);
            return;
          }
          callbackFinished = true;
          finishIfReady();
        }
      );
      needsDrain = !accepted;
      finishIfReady();
    } catch (error: unknown) {
      finish(toError(error));
    }
  });
}

function throwIfAborted(signal: AbortSignal | null): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function createAbortError(message = "account-sync operation aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
