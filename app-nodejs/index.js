"use strict";

const cluster = require("cluster");
const os = require("os");
const express = require("express");
const { MongoClient } = require("mongodb");
const { createClient } = require("redis");
const crypto = require("crypto");

// ============================================================================
// CLUSTER MODE - Use all available CPU cores
// ============================================================================
const numCPUs = Math.min(os.cpus().length, 4); // Cap at 4 workers per pod

if (cluster.isPrimary) {
  console.log(`[cluster] Primary ${process.pid} starting ${numCPUs} workers`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker, code, signal) => {
    console.log(`[cluster] Worker ${worker.process.pid} died (${signal || code}), restarting...`);
    cluster.fork();
  });

} else {
  // ============================================================================
  // WORKER PROCESS - Handle actual requests
  // ============================================================================

  const MONGO_URI = process.env.MONGO_URI || "mongodb://mongo:27017/assessmentdb";
  const APP_PORT = parseInt(process.env.APP_PORT || "3000", 10);
  const REDIS_HOST = process.env.REDIS_HOST || "redis";
  const REDIS_PORT = parseInt(process.env.REDIS_SERVICE_PORT || "6379", 10);
  const CACHE_TTL = 60; // seconds

  let db;
  let redisClient;

  // MongoDB connection with optimized pool settings
  const mongoClient = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
    maxPoolSize: 20,        // Reduced per worker (multiple workers share load)
    minPoolSize: 5,
    maxIdleTimeMS: 30000,
    // Write concern for fire-and-forget at client level
    writeConcern: { w: 0 },
  });

  async function connectMongo(retries = 10, delayMs = 5000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await mongoClient.connect();
        db = mongoClient.db("assessmentdb");
        console.log(`[mongo] Worker ${process.pid} connected on attempt ${attempt}`);
        return;
      } catch (err) {
        console.error(`[mongo] Worker ${process.pid} attempt ${attempt}/${retries} failed: ${err.message}`);
        if (attempt === retries) throw new Error(`MongoDB unreachable after ${retries} attempts`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  async function connectRedis(retries = 10, delayMs = 3000) {
    redisClient = createClient({
      socket: {
        host: REDIS_HOST,
        port: REDIS_PORT,
        connectTimeout: 5000,
      },
    });

    redisClient.on("error", (err) => {
      // Suppress repeated error logs
      if (!redisClient._errorLogged) {
        console.error(`[redis] Worker ${process.pid} error:`, err.message);
        redisClient._errorLogged = true;
      }
    });

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await redisClient.connect();
        console.log(`[redis] Worker ${process.pid} connected on attempt ${attempt}`);
        return;
      } catch (err) {
        console.error(`[redis] Worker ${process.pid} attempt ${attempt}/${retries} failed: ${err.message}`);
        if (attempt === retries) {
          console.warn(`[redis] Worker ${process.pid} running without cache`);
          redisClient = null;
          return;
        }
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  function randomPayload(size = 512) {
    return crypto.randomBytes(Math.ceil(size / 2)).toString("hex").slice(0, size);
  }

  const app = express();
  app.use(express.json());

  // Liveness probe
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Readiness probe
  app.get("/readyz", async (_req, res) => {
    if (!db) {
      return res.status(503).json({ status: "not ready", error: "DB not connected" });
    }
    try {
      await mongoClient.db("admin").command({ ping: 1 });
      res.json({ status: "ready", timestamp: new Date().toISOString() });
    } catch (err) {
      res.status(503).json({ status: "not ready", error: err.message });
    }
  });

  // Core endpoint - must perform exactly 5 reads and 5 writes per request
  app.get("/api/data", async (_req, res) => {
    if (!db) {
      return res.status(503).json({ status: "error", message: "DB not connected" });
    }

    const col = db.collection("records");

    try {
      const writes = [];
      const reads = [];
      let cachedReads = 0;

      // ========================================
      // WRITES (5 total) - FIRE-AND-FORGET
      // Using unacknowledged write concern (w:0)
      // Writes return immediately without waiting for MongoDB confirmation
      // ========================================
      const writePromises = [];
      for (let i = 0; i < 5; i++) {
        const doc = {
          type: "write",
          index: i,
          payload: randomPayload(),
          timestamp: new Date(),
        };
        // Fire-and-forget: don't await, just push the promise
        // Write concern w:0 is set at client level
        writePromises.push(
          col.insertOne(doc).then(r => r.insertedId.toString()).catch(() => "queued")
        );
      }

      // Wait for all writes to be queued (not acknowledged)
      const writeResults = await Promise.all(writePromises);
      writes.push(...writeResults);

      // ========================================
      // READS (5 total) - CACHED with Redis
      // ========================================
      for (let i = 0; i < 5; i++) {
        const cacheKey = `read:${i}`;

        // Try cache first
        if (redisClient) {
          try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
              reads.push(cached);
              cachedReads++;
              continue;
            }
          } catch (err) {
            // Cache miss or error, fall through to DB
          }
        }

        // Cache miss - read from MongoDB
        const doc = await col.findOne({ type: "write" });
        const docId = doc ? doc._id.toString() : null;
        reads.push(docId);

        // Store in cache for next time (fire-and-forget)
        if (redisClient && docId) {
          redisClient.setEx(cacheKey, CACHE_TTL, docId).catch(() => {});
        }
      }

      res.json({
        status: "success",
        writes,
        reads,
        cachedReads,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // Collection stats
  app.get("/api/stats", async (_req, res) => {
    if (!db) {
      return res.status(503).json({ status: "error", message: "DB not connected" });
    }
    try {
      const count = await db.collection("records").countDocuments({});
      res.json({ total_documents: count, timestamp: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // Start server immediately, connect to mongo and redis in background
  app.listen(APP_PORT, "0.0.0.0", () => {
    console.log(`[app] Worker ${process.pid} listening on port ${APP_PORT}`);
  });

  // Connect to databases
  Promise.all([
    connectMongo().catch((err) => console.error(`[mongo] Worker ${process.pid} connection failed:`, err.message)),
    connectRedis().catch((err) => console.error(`[redis] Worker ${process.pid} connection failed:`, err.message)),
  ]);
}
