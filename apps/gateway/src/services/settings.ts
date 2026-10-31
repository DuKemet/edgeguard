import {
  DEFAULT_DETECTION_SETTINGS,
  detectionSettingsSchema,
  type DetectionSettings,
  type Settings,
} from "@edgeguard/shared";
import type { GatewayConfig } from "../config";
import type { Logger } from "../logger";
import type { RedisManager } from "../redis";

export class SettingsService {
  private readonly redis: RedisManager;
  private readonly key: string;
  private readonly logger: Logger;
  private memory: Settings = {
    detection: { ...DEFAULT_DETECTION_SETTINGS },
    updatedAt: new Date().toISOString(),
  };

  constructor(redis: RedisManager, config: GatewayConfig, logger: Logger) {
    this.redis = redis;
    this.logger = logger;
    this.key = `${config.redisPrefix}:settings`;
  }

  async init(): Promise<void> {
    if (!this.redis.isReady()) return;
    try {
      await this.seedIfNeeded();
    } catch (error) {
      this.redis.reportError("settings_seed", error);
    }
  }

  private async seedIfNeeded(): Promise<void> {
    const exists = await this.redis.client.exists(this.key);
    if (exists === 0) {
      const settings: Settings = {
        detection: { ...DEFAULT_DETECTION_SETTINGS },
        updatedAt: new Date().toISOString(),
      };
      await this.redis.client.set(this.key, JSON.stringify(settings), "NX");
      this.memory = settings;
      this.logger.info("seeded default detection settings");
    }
  }

  async get(): Promise<Settings> {
    if (!this.redis.isReady()) return this.memory;
    try {
      await this.seedIfNeeded();
      const raw = await this.redis.client.get(this.key);
      if (!raw) return this.memory;
      const parsed = JSON.parse(raw) as Partial<Settings>;
      const detection = detectionSettingsSchema.safeParse(parsed.detection);
      if (!detection.success || typeof parsed.updatedAt !== "string") {
        this.logger.warn("invalid settings stored in redis; keeping last valid settings");
        return this.memory;
      }
      this.memory = { detection: detection.data, updatedAt: parsed.updatedAt };
      return this.memory;
    } catch (error) {
      this.redis.reportError("settings_get", error);
      return this.memory;
    }
  }

  async update(detection: DetectionSettings): Promise<Settings> {
    const settings: Settings = {
      detection,
      updatedAt: new Date().toISOString(),
    };
    this.memory = settings;
    if (this.redis.isReady()) {
      try {
        await this.redis.client.set(this.key, JSON.stringify(settings));
      } catch (error) {
        this.redis.reportError("settings_write", error);
      }
    }
    return settings;
  }
}
