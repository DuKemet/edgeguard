import request from "supertest";
import { describe, expect, it } from "vitest";
import { createDemoApp } from "../src/app";
import { DemoMetrics } from "../src/metrics";

const app = createDemoApp();

describe("demo API", () => {
  it("reports health", async () => {
    const response = await request(app).get("/api/health").expect(200);
    expect(response.body).toMatchObject({ status: "ok", service: "edgeguard-demo-api" });
    expect(response.headers["x-request-id"]).toBeTruthy();
  });

  it("lists products with filters and validation", async () => {
    const all = await request(app).get("/api/products").expect(200);
    expect(all.body.items.length).toBeGreaterThan(0);
    expect(all.body.total).toBe(all.body.items.length);

    const audio = await request(app).get("/api/products?category=audio&limit=1").expect(200);
    expect(audio.body.items).toHaveLength(1);
    expect(audio.body.items[0].category).toBe("audio");

    await request(app).get("/api/products?limit=0").expect(400);
    await request(app).get("/api/products?category=unknown").expect(400);
  });

  it("returns single products or 404", async () => {
    const found = await request(app).get("/api/products/p-100").expect(200);
    expect(found.body.item.id).toBe("p-100");
    await request(app).get("/api/products/nope").expect(404);
  });

  it("creates orders and validates input", async () => {
    const created = await request(app)
      .post("/api/orders")
      .send({ productId: "p-105", quantity: 1 })
      .expect(201);
    expect(created.body.item).toMatchObject({ productId: "p-105", quantity: 1, status: "pending" });

    await request(app).post("/api/orders").send({ productId: "missing", quantity: 1 }).expect(400);
    await request(app).post("/api/orders").send({ productId: "p-100", quantity: 99 }).expect(400);
  });

  it("returns the profile", async () => {
    const response = await request(app).get("/api/profile").expect(200);
    expect(response.body.item).toMatchObject({ id: "u-42", tier: "gold" });
  });

  it("echoes bodies", async () => {
    const response = await request(app)
      .post("/api/echo")
      .send({ ping: "pong" })
      .expect(200);
    expect(response.body).toEqual({ method: "POST", body: { ping: "pong" } });
  });

  it("supports simulated latency and failures", async () => {
    const slow = await request(app).get("/api/slow?ms=5").expect(200);
    expect(slow.body).toEqual({ slow: true, delayMs: 5 });
    const failure = await request(app).get("/api/error?status=503").expect(503);
    expect(failure.body.error.code).toBe("DEMO_ERROR");
    await request(app).get("/api/error?status=200").expect(400);
  });

  it("rejects malformed JSON and unknown routes", async () => {
    await request(app)
      .post("/api/echo")
      .set("content-type", "application/json")
      .send('{"broken":')
      .expect(400);
    const missing = await request(app).get("/nope").expect(404);
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });

  it("exports Prometheus metrics", async () => {
    await request(app).get("/api/products").expect(200);
    const response = await request(app).get("/metrics").expect(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.text).toContain("edgeguard_demo_requests_total");
    expect(response.text).toContain('service="edgeguard-demo-api"');
  });
});

describe("DemoMetrics", () => {
  it("records bounded route labels", async () => {
    const metrics = new DemoMetrics("1.0.0");
    metrics.observe({ route: "/api/products", method: "GET", status: 200, durationSeconds: 0.01 });
    const rendered = await metrics.render();
    expect(rendered.body).toContain('route="/api/products"');
    expect(rendered.body).toContain('status="200"');
  });
});
