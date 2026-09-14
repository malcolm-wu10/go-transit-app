import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import fetch from "node-fetch";
import { startPolling } from "./services/gtfsRealtime.js";
import { mockVehicles } from "./services/mockData.js";
import { staticGtfsPlan } from "./services/gtfsSchedulePlanner.js";

const PORT = process.env.PORT || 4000;
const API_KEY = (process.env.GO_API_KEY || "").trim();
const HAS_API_KEY = Boolean(API_KEY) && API_KEY !== "your_key_here";
const HAS_GTFS_CONFIG = Boolean(
  process.env.GTFS_RT_VEHICLE_POSITIONS_URL && process.env.GTFS_RT_TRIP_UPDATES_URL
);
const LIVE_FEED_ENABLED = HAS_API_KEY && HAS_GTFS_CONFIG;

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws/vehicles" });

let latestVehicles = [];

function broadcastVehicles(vehicles) {
  latestVehicles = vehicles;
  const payload = JSON.stringify({ type: "vehicles", data: vehicles });
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(payload);
  });
}

// --- Live vehicle feed -----------------------------------------------------

if (LIVE_FEED_ENABLED) {
  startPolling({
    vehicleUrl: process.env.GTFS_RT_VEHICLE_POSITIONS_URL,
    tripUpdatesUrl: process.env.GTFS_RT_TRIP_UPDATES_URL,
    apiKey: API_KEY,
    intervalMs: Number(process.env.POLL_INTERVAL_MS || 30000),
    onUpdate: broadcastVehicles,
    onError: (err) => console.error("[gtfs-rt] poll failed:", err.message),
  });
  console.log("[gtfs-rt] polling live Metrolinx feed");
} else {
  const reason = !HAS_API_KEY
    ? "GO_API_KEY is not configured with a real value."
    : "GTFS-RT URLs are not configured.";

  console.warn(
    `[gtfs-rt] Live feed disabled — serving mock vehicle data so the frontend can still render. ${reason} Register at https://api.gotransit.com and fill in backend/.env with the real GO_API_KEY and GTFS-RT URLs to go live.`
  );
  setInterval(() => broadcastVehicles(mockVehicles()), 5000);
  broadcastVehicles(mockVehicles());
}

app.get("/api/vehicles", (_req, res) => {
  res.json({ vehicles: latestVehicles, live: LIVE_FEED_ENABLED });
});

// --- Trip planning (proxies to a self-hosted OpenTripPlanner instance) -----
// See README for OTP setup. Until OTP is running, this returns a 503 with
// a clear message rather than fake data, since trip results are exactly
// the kind of thing you don't want to silently fake.

app.get("/api/plan", async (req, res) => {
  const { fromLat, fromLon, toLat, toLon, mode, date, time, arriveBy } = req.query;

  if (!fromLat || !fromLon || !toLat || !toLon) {
    return res.status(400).json({ error: "fromLat, fromLon, toLat, toLon are required" });
  }

  const fallbackPlan = () => {
    const plan = staticGtfsPlan({ fromLat, fromLon, toLat, toLon, mode, date, time, arriveBy: arriveBy === "true" });
    return res.json(plan ?? { plan: { itineraries: [] }, source: "static-gtfs" });
  };

  if (!process.env.OTP_URL) {
    return fallbackPlan();
  }

  const otpParams = new URLSearchParams({
    fromPlace: `${fromLat},${fromLon}`,
    toPlace: `${toLat},${toLon}`,
    mode: mode || "TRANSIT,RAIL,BUS,WALK",
    date: date || new Date().toISOString().slice(0, 10),
    time: time || new Date().toTimeString().slice(0, 5),
    arriveBy: arriveBy === "true" ? "true" : "false",
    numItineraries: "5",
  });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const otpRes = await fetch(`${process.env.OTP_URL}/plan?${otpParams.toString()}`, {
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    const data = await otpRes.json();

    if (!otpRes.ok || !data?.plan?.itineraries) {
      return fallbackPlan();
    }

    res.json(data);
  } catch (err) {
    return fallbackPlan();
  }
});

wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "vehicles", data: latestVehicles }));
});

httpServer.listen(PORT, () => {
  console.log(`GO Transit backend listening on http://localhost:${PORT}`);
});
