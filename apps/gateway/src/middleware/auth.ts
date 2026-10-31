import type { RequestHandler } from "express";
import type { AuthUser } from "@edgeguard/shared";
import { ForbiddenError, UnauthorizedError } from "../errors";
import type { AuthService } from "../services/auth";
import { extractBearerToken } from "../services/auth";

export function createRequireAuth(auth: AuthService): RequestHandler {
  return (req, _res, next) => {
    const token = extractBearerToken(req.header("authorization"));
    if (!token) return next(new UnauthorizedError());
    const user = auth.verifyToken(token);
    if (!user) return next(new UnauthorizedError("Invalid or expired session"));
    req.user = user;
    return next();
  };
}

export function requireRole(role: AuthUser["role"]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(new UnauthorizedError());
    if (req.user.role !== role) {
      return next(new ForbiddenError(`This action requires the '${role}' role`));
    }
    return next();
  };
}
