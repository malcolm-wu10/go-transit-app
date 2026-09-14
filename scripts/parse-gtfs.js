#!/usr/bin/env node
// Parses the static GTFS feeds in data/gtfs/{go,up} and writes the frontend map JSON files.

import { createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FEEDS = [
  { name: "go", dir: path.join(ROOT, "data/gtfs/go") },
  { name: "up", dir: path.join(ROOT, "data/gtfs/up") },
];
const OUT_DIR = path.join(ROOT, "frontend/src/data/generated");

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.replace(/\r$/, ""));
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

async function streamCsv(filePath, onRow) {
  if (!existsSync(filePath)) return false;
  const rl = createInterface({ input: createReadStream(filePath, "utf8"), crlfDelay: Infinity });
  let header = null;
  for await (const rawLine of rl) {
    if (rawLine.length === 0) continue;
    const line = header === null ? stripBom(rawLine) : rawLine;
    const cells = splitCsvLine(line);
    if (header === null) {
      header = cells;
      continue;
    }
    const row = {};
    header.forEach((h, i) => (row[h] = cells[i]));
    onRow(row);
  }
  return true;
}

function readCsvSync(filePath) {
  if (!existsSync(filePath)) return [];
  const text = stripBom(readFileSync(filePath, "utf8"));
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    header.forEach((h, i) => (row[h] = cells[i]));
    return row;
  });
}

const allStops = new Map();
const railFeatures = [];

for (const feed of FEEDS) {
  console.log(`\n[${feed.name}] parsing ${feed.dir}`);

  const routesRows = readCsvSync(path.join(feed.dir, "routes.txt"));
  const routesById = new Map(
    routesRows.map((r) => [
      r.route_id,
      {
        routeId: r.route_id,
        shortName: r.route_short_name || r.route_long_name || r.route_id,
        longName: r.route_long_name || r.route_short_name || "",
        type: Number(r.route_type),
        color: r.route_color ? `#${r.route_color}` : "#666666",
      },
    ])
  );
  console.log(`  routes: ${routesById.size}`);

  const stopsRows = readCsvSync(path.join(feed.dir, "stops.txt"));
  for (const s of stopsRows) {
    if (!s.stop_lat || !s.stop_lon) continue;
    if (!allStops.has(s.stop_id)) {
      allStops.set(s.stop_id, {
        id: s.stop_id,
        name: s.stop_name,
        lat: Number(s.stop_lat),
        lon: Number(s.stop_lon),
        routes: new Map(),
      });
    }
  }
  console.log(`  stops: ${stopsRows.length}`);

  const tripsById = new Map();
  await streamCsv(path.join(feed.dir, "trips.txt"), (row) => {
    tripsById.set(row.trip_id, { routeId: row.route_id, shapeId: row.shape_id });
  });
  console.log(`  trips: ${tripsById.size}`);

  let stopTimesRows = 0;
  await streamCsv(path.join(feed.dir, "stop_times.txt"), (row) => {
    stopTimesRows++;
    const trip = tripsById.get(row.trip_id);
    if (!trip) return;
    const stop = allStops.get(row.stop_id);
    const route = routesById.get(trip.routeId);
    if (!stop || !route) return;
    if (!stop.routes.has(route.routeId)) stop.routes.set(route.routeId, route);
  });
  console.log(`  stop_times rows processed: ${stopTimesRows}`);

  const shapeIds = new Map();
  for (const trip of tripsById.values()) {
    const route = routesById.get(trip.routeId);
    if (route && trip.shapeId && !shapeIds.has(trip.shapeId)) {
      shapeIds.set(trip.shapeId, route);
    }
  }
  console.log(`  distinct route shapes: ${shapeIds.size}`);

  const shapePoints = new Map();
  await streamCsv(path.join(feed.dir, "shapes.txt"), (row) => {
    if (!shapeIds.has(row.shape_id)) return;
    if (!shapePoints.has(row.shape_id)) shapePoints.set(row.shape_id, []);
    shapePoints.get(row.shape_id).push({
      seq: Number(row.shape_pt_sequence),
      lat: Number(row.shape_pt_lat),
      lon: Number(row.shape_pt_lon),
    });
  });

  for (const [shapeId, points] of shapePoints) {
    points.sort((a, b) => a.seq - b.seq);
    const route = shapeIds.get(shapeId);
    const step = Math.max(1, Math.ceil(points.length / 350));
    const sampledPoints = points.filter((_, index) => index === 0 || index === points.length - 1 || index % step === 0);
    railFeatures.push({
      type: "Feature",
      properties: {
        routeId: route.routeId,
        shortName: route.shortName,
        name: route.longName,
        type: route.type,
        color: route.color,
        shapeId,
      },
      geometry: { type: "LineString", coordinates: sampledPoints.map((p) => [p.lon, p.lat]) },
    });
  }
  console.log(`  rail line features built: ${shapePoints.size}`);
}

mkdirSync(OUT_DIR, { recursive: true });

const stopsOut = Array.from(allStops.values())
  .filter((s) => s.routes.size > 0)
  .map((s) => ({
    id: s.id,
    name: s.name,
    lat: s.lat,
    lon: s.lon,
    routes: Array.from(s.routes.values()).map((r) => ({
      routeId: r.routeId,
      shortName: r.shortName,
      longName: r.longName,
      type: r.type,
      color: r.color,
    })),
  }));

writeFileSync(path.join(OUT_DIR, "stops.json"), JSON.stringify(stopsOut));
writeFileSync(
  path.join(OUT_DIR, "lines.json"),
  JSON.stringify({ type: "FeatureCollection", features: railFeatures })
);

console.log(`\nWrote ${stopsOut.length} stops -> frontend/src/data/generated/stops.json`);
console.log(`Wrote ${railFeatures.length} rail line features -> frontend/src/data/generated/lines.json`);
