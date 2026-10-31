import bcrypt from "bcryptjs";
import jwt, { type JwtPayload, type SignOptions } from "jsonwebtoken";
import type { AuthUser, LoginResponse } from "@edgeguard/shared";
import type { GatewayConfig } from "../config";
import type { Logger } from "../logger";

const DUMMY_HASH = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

interface UserRecord {
  username: string;
  role: AuthUser["role"];
  passwordHash: string;
}

export class AuthService {
  private readonly users: UserRecord[];
  private readonly config: GatewayConfig;
  private readonly logger: Logger;

  constructor(config: GatewayConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.users = [
      {
        username: config.adminUsername,
        role: "admin",
        passwordHash: config.adminPasswordHash,
      },
    ];
    if (config.viewerUsername && config.viewerPasswordHash) {
      this.users.push({
        username: config.viewerUsername,
        role: "viewer",
        passwordHash: config.viewerPasswordHash,
      });
    }
  }

  async verifyCredentials(username: string, password: string): Promise<AuthUser | null> {
    const user = this.users.find((candidate) => candidate.username === username);
    const hash = user?.passwordHash ?? DUMMY_HASH;
    const matches = await bcrypt.compare(password, hash);
    if (!user || !matches) {
      this.logger.warn({ username: user ? username : "unknown" }, "admin login failed");
      return null;
    }
    return { username: user.username, role: user.role };
  }

  issueToken(user: AuthUser): LoginResponse {
    const options: SignOptions = {
      algorithm: "HS256",
      expiresIn: this.config.tokenTtlSeconds,
      issuer: this.config.jwtIssuer,
      audience: this.config.jwtAudience,
      subject: user.username,
    };
    const token = jwt.sign({ role: user.role }, this.config.jwtSecret, options);
    const expiresAt = new Date(Date.now() + this.config.tokenTtlSeconds * 1000).toISOString();
    return { token, expiresAt, user };
  }

  verifyToken(token: string): AuthUser | null {
    try {
      const payload = jwt.verify(token, this.config.jwtSecret, {
        algorithms: ["HS256"],
        issuer: this.config.jwtIssuer,
        audience: this.config.jwtAudience,
      }) as JwtPayload;
      const role = payload.role;
      const username = payload.sub;
      if (
        typeof username !== "string" ||
        (role !== "admin" && role !== "viewer") ||
        !this.users.some((user) => user.username === username)
      ) {
        return null;
      }
      return { username, role };
    } catch {
      return null;
    }
  }
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}
