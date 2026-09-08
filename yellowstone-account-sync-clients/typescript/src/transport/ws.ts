import { Buffer } from "buffer";
import type { AccountSubscriptionTransport, TransportHandlers } from "../core/transport";
import type { AccountSyncCommitment } from "../core/types";
import { SubscribeRequest, SubscribeUpdate } from "../generated/grpc/geyser";
import { normalizeWsSubscriptionEndpoint, setsEqual } from "./common";
import {
  createSubscribeRequest,
  subscribeUpdateToAccountUpdate
} from "./protobuf";

const WS_CONNECTING = 0;
const WS_OPEN = 1;

export interface WebSocketLike {
  readyState: number;
  send(data: Uint8Array | ArrayBuffer | Buffer): unknown;
  close(code?: number, reason?: string): unknown;
  addEventListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeEventListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  off?: (event: string, handler: (...args: unknown[]) => void) => void;
  binaryType?: string;
}

export type WebSocketFactory = (endpoint: string) => WebSocketLike;

// What: WebSocket transport implementation for account subscriptions.
// Why: Browser and Node clients need one binary streaming protocol implementation.
// How: Keep one websocket session and send full desired account sets on change.
export class WsAccountSubscriptionTransport implements AccountSubscriptionTransport {
  private readonly endpoint: string;
  private readonly createSocket: WebSocketFactory;
  private readonly connectTimeoutMs: number;

  private handlers: TransportHandlers | null = null;
  private socket: WebSocketLike | null = null;
  private openPromise: Promise<void> | null = null;
  private operationChain: Promise<void> = Promise.resolve();
  private intentionallyClosing = false;
  private closed = false;
  private lifecycleSignal: AbortSignal | null = null;

  private appliedAccountIds = new Set<string>();
  private appliedCommitment: AccountSyncCommitment | null = null;

  constructor(
    endpoint: string,
    createSocket: WebSocketFactory,
    connectTimeoutMs = 10_000
  ) {
    this.endpoint = normalizeWsSubscriptionEndpoint(endpoint);
    this.createSocket = createSocket;
    this.connectTimeoutMs = connectTimeoutMs;
  }

  public async connect(
    handlers: TransportHandlers,
    signal: AbortSignal
  ): Promise<void> {
    throwIfAborted(signal);
    this.handlers = handlers;
    this.lifecycleSignal = signal;
    await this.enqueue(async () => {
      await this.ensureOpen();
    });
  }

  public async setTrackedAccounts(
    accountIds: readonly string[],
    commitment: AccountSyncCommitment
  ): Promise<void> {
    await this.enqueue(async () => {
      throwIfAborted(this.lifecycleSignal);
      const nextAccountIds = new Set(accountIds.filter((accountId) => accountId.length > 0));
      if (
        setsEqual(nextAccountIds, this.appliedAccountIds) &&
        this.appliedCommitment === commitment
      ) {
        return;
      }

      await this.ensureOpen();
      this.sendSubscribeRequest([...nextAccountIds], commitment);
      this.appliedAccountIds = nextAccountIds;
      this.appliedCommitment = commitment;
    });
  }

  public async close(): Promise<void> {
    this.closed = true;
    await this.enqueue(async () => {
      this.appliedAccountIds.clear();
      this.appliedCommitment = null;
      await this.closeSocket();
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

  private async ensureOpen(): Promise<void> {
    if (this.closed) {
      throw new Error("websocket transport is closed");
    }
    throwIfAborted(this.lifecycleSignal);

    if (this.socket && this.socket.readyState === WS_OPEN) {
      return;
    }

    if (this.openPromise) {
      await this.openPromise;
      return;
    }

    this.openPromise = this.openSocket();
    try {
      await this.openPromise;
    } finally {
      this.openPromise = null;
    }
  }

  private async openSocket(): Promise<void> {
    const signal = this.lifecycleSignal;
    if (!signal) {
      throw new Error("websocket transport is missing a lifecycle signal");
    }
    throwIfAborted(signal);

    const socket = this.createSocket(this.endpoint);
    if (typeof socket.binaryType === "string") {
      socket.binaryType = "arraybuffer";
    }

    this.intentionallyClosing = false;
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let openingCancelled = false;

      const cleanupSetup = () => {
        clearTimeout(timeoutId);
        signal.removeEventListener("abort", handleAbort);
        removeSocketListener(socket, "open", handleOpen);
      };

      const rejectOpening = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        openingCancelled = true;
        cleanupSetup();
        removeSocketListener(socket, "error", handleError);
        removeSocketListener(socket, "close", handleClose);
        removeSocketListener(socket, "message", handleMessage);
        if (this.socket === socket) {
          this.socket = null;
        }
        try {
          socket.close();
        } catch {
          // The timeout or abort error remains the useful failure.
        }
        reject(error);
      };

      const handleOpen = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupSetup();
        resolve();
      };

      const handleError = (error: unknown) => {
        const asError =
          error instanceof Error
            ? error
            : new Error(typeof error === "string" ? error : "websocket error");

        if (!settled) {
          rejectOpening(asError);
          return;
        }

        if (!openingCancelled && !this.intentionallyClosing) {
          this.handlers?.onTransportError(asError);
        }
      };

      const handleClose = () => {
        if (this.socket === socket) {
          this.socket = null;
        }
        if (!settled) {
          rejectOpening(
            new Error("websocket closed before connection was established")
          );
          return;
        }

        if (!openingCancelled && !this.intentionallyClosing) {
          this.handlers?.onTransportError(new Error("websocket stream closed"));
        }
      };

      const handleMessage = (eventOrData: unknown) => {
        if (openingCancelled) {
          return;
        }
        void this.processMessage(eventOrData);
      };

      const handleAbort = () => {
        rejectOpening(createAbortError());
      };

      const timeoutId = setTimeout(() => {
        const error = new Error(
          `websocket connection timed out after ${this.connectTimeoutMs}ms`
        );
        error.name = "AccountSyncConnectTimeoutError";
        rejectOpening(error);
      }, this.connectTimeoutMs);

      try {
        addSocketListener(socket, "open", handleOpen);
        addSocketListener(socket, "error", handleError);
        addSocketListener(socket, "close", handleClose);
        addSocketListener(socket, "message", handleMessage);
        signal.addEventListener("abort", handleAbort, { once: true });
        if (signal.aborted) {
          handleAbort();
        }
      } catch (error: unknown) {
        rejectOpening(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    });
  }

  private async closeSocket(): Promise<void> {
    if (!this.socket) {
      return;
    }

    this.intentionallyClosing = true;
    const socketToClose = this.socket;
    this.socket = null;
    socketToClose.close();
  }

  private sendSubscribeRequest(
    accountIds: readonly string[],
    commitment: AccountSyncCommitment
  ): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WS_OPEN) {
      throw new Error("websocket is not open");
    }

    const request = createSubscribeRequest(accountIds, commitment);
    const payload = SubscribeRequest.encode(request).finish();
    socket.send(payload);
  }

  private async processMessage(eventOrData: unknown): Promise<void> {
    const rawData = extractMessageData(eventOrData);
    const binary = await normalizeIncomingBinary(rawData);
    if (!binary) {
      return;
    }

    const update = SubscribeUpdate.decode(binary);
    const accountUpdate = subscribeUpdateToAccountUpdate(update);
    if (!accountUpdate) {
      return;
    }

    this.handlers?.onAccountUpdate(accountUpdate);
  }
}

function addSocketListener(
  socket: WebSocketLike,
  event: string,
  handler: (...args: unknown[]) => void
): void {
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(event, handler);
    return;
  }

  if (typeof socket.on === "function") {
    socket.on(event, handler);
    return;
  }

  throw new Error("websocket implementation does not support event listeners");
}

function removeSocketListener(
  socket: WebSocketLike,
  event: string,
  handler: (...args: unknown[]) => void
): void {
  if (typeof socket.removeEventListener === "function") {
    socket.removeEventListener(event, handler);
    return;
  }

  socket.off?.(event, handler);
}

function extractMessageData(eventOrData: unknown): unknown {
  if (
    eventOrData &&
    typeof eventOrData === "object" &&
    "data" in (eventOrData as Record<string, unknown>)
  ) {
    return (eventOrData as Record<string, unknown>).data;
  }

  return eventOrData;
}

async function normalizeIncomingBinary(raw: unknown): Promise<Uint8Array | null> {
  if (raw instanceof Uint8Array) {
    return raw;
  }

  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw);
  }

  if (Buffer.isBuffer(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }

  if (raw && typeof raw === "object" && "arrayBuffer" in (raw as Blob)) {
    const blob = raw as Blob;
    const arrayBuffer = await blob.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }

  return null;
}

function throwIfAborted(signal: AbortSignal | null): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function createAbortError(): Error {
  const error = new Error("account-sync operation aborted");
  error.name = "AbortError";
  return error;
}
