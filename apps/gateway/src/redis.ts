import Redis from "ioredis";
import type { Logger } from "./logger";

export interface RedisManagerOptions {
  url: string;
  connectTimeoutMs: number;
  commandTimeoutMs: number;
  logger: Logger;
  onError?: (operation: string) => void;
}

export class RedisManager {
  readonly client: Redis;
  private readonly logger: Logger;
  private readonly onError?: (operation: string) => void;
  private ready = false;
  private lastError: string | null = null;

  constructor(options: RedisManagerOptions) {
    this.logger = options.logger;
    this.onError = options.onError;
    this.client = new Redis(options.url, {
      lazyConnect: true,
      connectTimeout: options.connectTimeoutMs,
      commandTimeout: options.commandTimeoutMs,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(250 * 2 ** Math.min(times, 4), 5_000),
    });

    this.client.on("ready", () => {
      if (!this.ready) this.logger.info("redis connection ready");
      this.ready = true;
      this.lastError = null;
    });
    this.client.on("close", () => {
      if (this.ready) this.logger.warn("redis connection closed");
      this.ready = false;
    });
    this.client.on("end", () => {
      this.ready = false;
    });
    this.client.on("error", (error: Error) => {
      this.lastError = error.message;
      this.ready = false;
      this.onError?.("connection");
      this.logger.debug({ err: error.message }, "redis error");
    });
  }

  async connect(): Promise<boolean> {
    try {
      await this.client.connect();
      this.ready = true;
      return true;
    } catch (error) {
      this.ready = false;
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "redis unavailable at startup; running in degraded local-fallback mode",
      );
      return false;
    }
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      this.ready = result === "PONG";
      return this.ready;
    } catch {
      this.ready = false;
      return false;
    }
  }

  isReady(): boolean {
    return this.ready && this.client.status === "ready";
  }

  lastErrorMessage(): string | null {
    return this.lastError;
  }

  reportError(operation: string, error?: unknown): void {
    this.onError?.(operation);
    if (error) {
      this.logger.debug(
        { err: error instanceof Error ? error.message : String(error) },
        "redis operation failed",
      );
    }
  }

  async close(): Promise<void> {
    this.ready = false;
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
