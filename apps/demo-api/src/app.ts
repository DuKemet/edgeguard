import { randomUUID } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { SERVICE_VERSION } from "@edgeguard/shared";
import { ORDERS, PRODUCTS, PROFILE, type Order } from "./data";
import { DemoMetrics } from "./metrics";

export interface DemoAppOptions {
  version?: string;
  metrics?: DemoMetrics;
}

const startedAt = Date.now();

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: { code: "BAD_REQUEST", message } });
}

function parseInteger(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createDemoApp(options: DemoAppOptions = {}): Express {
  const version = options.version ?? SERVICE_VERSION;
  const metrics = options.metrics ?? new DemoMetrics(version);
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  app.use((req, res, next) => {
    const requestId = req.header("x-request-id") ?? randomUUID();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const route = typeof req.route?.path === "string" ? req.route.path : "other";
      metrics.observe({
        route,
        method: req.method,
        status: res.statusCode,
        durationSeconds: Number(process.hrtime.bigint() - started) / 1e9,
      });
    });
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      status: "ok",
      service: "edgeguard-demo-api",
      version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1_000),
    });
  });

  app.get("/api/products", (req, res) => {
    const limit = parseInteger(req.query.limit, 20, 1, 50);
    if (limit === null) {
      badRequest(res, "limit must be an integer between 1 and 50");
      return;
    }
    const category = typeof req.query.category === "string" ? req.query.category : undefined;
    if (category && !["audio", "computing", "accessories"].includes(category)) {
      badRequest(res, "category must be audio, computing or accessories");
      return;
    }
    const search = typeof req.query.q === "string" ? req.query.q.toLowerCase() : undefined;
    const items = PRODUCTS.filter((product) => {
      if (category && product.category !== category) return false;
      if (search && !product.name.toLowerCase().includes(search)) return false;
      return true;
    }).slice(0, limit);
    res.json({ items, total: items.length, generatedAt: new Date().toISOString() });
  });

  app.get("/api/products/:id", (req, res) => {
    const product = PRODUCTS.find((candidate) => candidate.id === req.params.id);
    if (!product) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Product not found" } });
      return;
    }
    res.json({ item: product });
  });

  app.get("/api/orders", (_req, res) => {
    res.json({
      items: ORDERS,
      total: ORDERS.length,
      generatedAt: new Date().toISOString(),
    });
  });

  app.post("/api/orders", (req, res) => {
    const body = req.body as { productId?: unknown; quantity?: unknown } | undefined;
    const productId = typeof body?.productId === "string" ? body.productId : "";
    const product = PRODUCTS.find((candidate) => candidate.id === productId);
    if (!product) {
      badRequest(res, "productId must reference an existing product");
      return;
    }
    const quantity = parseInteger(body?.quantity, 1, 1, 10);
    if (quantity === null) {
      badRequest(res, "quantity must be an integer between 1 and 10");
      return;
    }
    if (product.stock < quantity) {
      res.status(409).json({ error: { code: "OUT_OF_STOCK", message: "Not enough stock" } });
      return;
    }
    const order: Order = {
      id: `o-${randomUUID().slice(0, 8)}`,
      productId,
      quantity,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    ORDERS.unshift(order);
    product.stock -= quantity;
    res.status(201).json({ item: order });
  });

  app.get("/api/profile", (_req, res) => {
    res.json({ item: PROFILE });
  });

  app.post("/api/echo", (req, res) => {
    res.json({ method: req.method, body: req.body ?? null });
  });

  app.get("/api/slow", async (req, res) => {
    const ms = parseInteger(req.query.ms, 250, 1, 5_000);
    if (ms === null) {
      badRequest(res, "ms must be an integer between 1 and 5000");
      return;
    }
    await delay(ms);
    res.json({ slow: true, delayMs: ms });
  });

  app.get("/api/error", (req, res) => {
    const status = parseInteger(req.query.status, 500, 400, 599);
    if (status === null) {
      badRequest(res, "status must be an integer between 400 and 599");
      return;
    }
    res.status(status).json({
      error: { code: "DEMO_ERROR", message: "Simulated upstream failure" },
    });
  });

  app.get("/metrics", async (_req, res) => {
    const rendered = await metrics.render();
    res.setHeader("Content-Type", rendered.contentType);
    res.setHeader("Cache-Control", "no-store");
    res.send(rendered.body);
  });

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { type?: string }).type === "entity.too.large"
    ) {
      res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Body is too large" } });
      return;
    }
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: { code: "INVALID_BODY", message: "Invalid JSON body" } });
      return;
    }
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal error" } });
  });

  return app;
}
