"use strict";

const express = require("express");
const serverless = require("serverless-http");
const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

const app = express();

const FF_API_KEY = process.env.FF_API_KEY || "VJjAaQFwrzagWcB1R2tYr33ScuJBTQ18OyxP9aI4lEc";
const FF_API_BASE = "https://api.gameskinbo.com";
const ADMIN_KEY = process.env.ADMIN_KEY || "rasin.admin";

const PACKAGES = [
  { id: "d25", name: "25 Diamond", price: 42 },
  { id: "d50", name: "50 Diamond", price: 56 },
  { id: "d75", name: "75 Diamond", price: 80 },
  { id: "d100", name: "100 Diamond", price: 95 },
  { id: "d115", name: "115 Diamond", price: 104 },
  { id: "d190", name: "190 Diamond", price: 172 },
  { id: "d240", name: "240 Diamond", price: 200 },
  { id: "d355", name: "355 Diamond", price: 300 },
  { id: "d480", name: "480 Diamond", price: 400 },
  { id: "d505", name: "505 Diamond", price: 430 },
  { id: "d610", name: "610 Diamond", price: 510 },
  { id: "d850", name: "850 Diamond", price: 700 },
  { id: "d1090", name: "1090 Diamond", price: 900 },
  { id: "d1240", name: "1240 Diamond", price: 1000 },
  { id: "d1480", name: "1480 Diamond", price: 1200 },
  { id: "d1850", name: "1850 Diamond", price: 1500 },
  { id: "d2090", name: "2090 Diamond", price: 1700 },
  { id: "d2530", name: "2530 Diamond", price: 2000 },
  { id: "d5060", name: "5060 Diamond", price: 4000 },
  { id: "wlite", name: "Weekly Lite", price: 60 },
  { id: "weekly", name: "Weekly Membership", price: 200 },
  { id: "monthly", name: "Monthly Membership", price: 950 },
];

const PACKAGE_MAP = new Map(PACKAGES.map((p) => [p.id, p]));

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-XSS-Protection", "0");
  next();
});

const rateBuckets = new Map();
let memoryOrders = [];

function rateLimit(maxPerMinute) {
  return (req, res, next) => {
    const ip = req.headers["x-forwarded-for"] || req.connection?.remoteAddress || "unknown";
    const now = Date.now();
    const windowStart = now - 60_000;
    const arr = (rateBuckets.get(ip) || []).filter((t) => t > windowStart);
    if (arr.length >= maxPerMinute) {
      return res.status(429).json({ ok: false, error: "Too many requests. Please slow down." });
    }
    arr.push(now);
    rateBuckets.set(ip, arr);
    next();
  };
}

async function readOrders() {
  try {
    const store = getStore({ name: "rasin_orders", consistency: "strong" });
    const data = await store.get("orders.json", { type: "json" });
    return Array.isArray(data) ? data : memoryOrders;
  } catch (err) {
    return memoryOrders;
  }
}

async function writeOrders(orders) {
  memoryOrders = orders;
  try {
    const store = getStore({ name: "rasin_orders", consistency: "strong" });
    await store.setJSON("orders.json", orders);
  } catch (err) {}
}

function cleanUid(v) {
  return String(v || "").replace(/\D/g, "").slice(0, 15);
}
function cleanOrderId(v) {
  return String(v || "").trim().replace(/[^\w-]/g, "").slice(0, 40);
}
function isValidUid(v) {
  return /^\d{6,15}$/.test(v);
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function requireAdmin(req, res, next) {
  const key = req.get("x-admin-key") || "";
  if (!key || !safeEqual(key, ADMIN_KEY)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

const router = express.Router();

router.get("/packages", (req, res) => {
  res.json({ ok: true, packages: PACKAGES });
});

router.get("/verify-uid", rateLimit(20), async (req, res) => {
  const uid = cleanUid(req.query.uid);
  if (!isValidUid(uid)) {
    return res.status(400).json({ ok: false, error: "Invalid UID. Enter a valid Free Fire UID." });
  }

  try {
    const url = `${FF_API_BASE}/ff-info/get?uid=${encodeURIComponent(uid)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    const apiRes = await fetch(url, {
      method: "GET",
      headers: {
        "x-api-key": FF_API_KEY,
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!apiRes.ok) {
      let msg = "UID not found. Please check the UID and try again.";
      if (apiRes.status === 429) msg = "Server busy. Please try again in a moment.";
      if (apiRes.status === 401 || apiRes.status === 403) msg = "Verification service temporarily blocking requests.";
      return res.status(apiRes.status === 429 ? 429 : 404).json({ ok: false, error: msg });
    }

    const contentType = apiRes.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return res.status(502).json({ ok: false, error: "Verification service unavailable." });
    }

    const data = await apiRes.json();
    const info = data && data.AccountInfo ? data.AccountInfo : null;
    const name = info && info.AccountName ? String(info.AccountName) : null;

    if (!name) {
      return res.status(404).json({ ok: false, error: "Could not read player name for this UID." });
    }

    return res.json({
      ok: true,
      uid,
      name,
      level: info.AccountLevel || null,
      region: info.AccountRegion || null,
    });
  } catch (err) {
    const aborted = err && err.name === "AbortError";
    return res.status(aborted ? 504 : 502).json({
      ok: false,
      error: aborted ? "Verification timed out. Please try again." : "Verification service unavailable.",
    });
  }
});

router.post("/confirm-order", rateLimit(30), async (req, res) => {
  const body = req.body || {};
  const uid = cleanUid(body.uid);
  const orderId = cleanOrderId(body.orderId);
  const packageId = String(body.packageId || "").trim();

  if (!isValidUid(uid)) {
    return res.status(400).json({ ok: false, status: "failed", error: "Invalid UID." });
  }
  if (!orderId) {
    return res.status(400).json({ ok: false, status: "failed", error: "Order ID is required." });
  }
  if (!PACKAGE_MAP.has(packageId)) {
    return res.status(400).json({ ok: false, status: "failed", error: "Invalid package selected." });
  }

  const orders = await readOrders();
  const match = orders.find(
    (o) =>
      cleanUid(o.uid) === uid &&
      cleanOrderId(o.orderId) === orderId &&
      String(o.packageId) === packageId
  );

  if (match && String(match.status).toLowerCase() === "approved") {
    return res.json({
      ok: true,
      status: "confirmed",
      message: "Order Confirmed! Your top-up will be delivered shortly.",
      package: PACKAGE_MAP.get(packageId),
    });
  }

  return res.json({
    ok: true,
    status: "failed",
    message: "Failed! This order is not approved. Please contact support with your Order ID.",
  });
});

router.post("/admin/login", (req, res) => {
  const key = (req.body && req.body.key) || "";
  if (safeEqual(key, ADMIN_KEY)) return res.json({ ok: true });
  return res.status(401).json({ ok: false, error: "Wrong admin key." });
});

router.get("/admin/orders", requireAdmin, async (req, res) => {
  const orders = await readOrders();
  res.json({ ok: true, orders });
});

router.post("/admin/orders", requireAdmin, async (req, res) => {
  const body = req.body || {};
  const uid = cleanUid(body.uid);
  const orderId = cleanOrderId(body.orderId);
  const packageId = String(body.packageId || "").trim();
  const status = String(body.status || "pending").toLowerCase();

  if (!isValidUid(uid)) return res.status(400).json({ ok: false, error: "Invalid UID." });
  if (!orderId) return res.status(400).json({ ok: false, error: "Order ID is required." });
  if (!PACKAGE_MAP.has(packageId)) return res.status(400).json({ ok: false, error: "Invalid package." });
  if (!["approved", "pending", "rejected"].includes(status)) {
    return res.status(400).json({ ok: false, error: "Invalid status." });
  }

  const orders = await readOrders();
  const record = {
    id: crypto.randomUUID(),
    uid,
    orderId,
    packageId,
    packageName: PACKAGE_MAP.get(packageId).name,
    price: PACKAGE_MAP.get(packageId).price,
    status,
    createdAt: new Date().toISOString(),
  };
  orders.unshift(record);
  await writeOrders(orders);
  res.json({ ok: true, order: record });
});

router.patch("/admin/orders/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const status = String((req.body && req.body.status) || "").toLowerCase();
  if (!["approved", "pending", "rejected"].includes(status)) {
    return res.status(400).json({ ok: false, error: "Invalid status." });
  }
  const orders = await readOrders();
  const idx = orders.findIndex((o) => o.id === id);
  if (idx === -1) return res.status(404).json({ ok: false, error: "Order not found." });
  orders[idx].status = status;
  orders[idx].updatedAt = new Date().toISOString();
  await writeOrders(orders);
  res.json({ ok: true, order: orders[idx] });
});

router.delete("/admin/orders/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const orders = await readOrders();
  const next = orders.filter((o) => o.id !== id);
  if (next.length === orders.length) return res.status(404).json({ ok: false, error: "Order not found." });
  await writeOrders(next);
  res.json({ ok: true });
});

app.use("/api", router);

app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

module.exports.handler = serverless(app);
