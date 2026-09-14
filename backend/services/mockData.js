import { readFileSync } from "node:fs";

// Use the real generated GO line geometry as the source of truth so mock vehicles
// travel along actual corridors instead of floating around the map.
const linesPath = new URL("../../frontend/src/data/generated/lines.json", import.meta.url);
const lineData = JSON.parse(readFileSync(linesPath, "utf8"));

const routeLookup = new Map(
  (lineData.features ?? []).map((feature) => {
    const routeId = String(feature.properties?.routeId ?? "");
    const normalized = routeId.replace(/^09261126-/, "").toUpperCase();
    return [normalized, feature.geometry?.coordinates ?? []];
  })
);

const routeAliases = {
  "GO-16": "LW",
  "GO-17": "LE",
  "GO-18": "MI",
  "GO-19": "BR",
  "GO-20": "RH",
  "GO-21": "ST",
};

function getRouteCoordinates(routeId) {
  const key = String(routeId ?? "").toUpperCase();
  const direct = routeLookup.get(key);
  if (direct && direct.length) return direct;

  const alias = routeAliases[key];
  if (alias) return routeLookup.get(alias) ?? [];

  return routeLookup.get(key.replace(/^GO-/, "")) ?? [];
}

function sampleRoutePoint(routeId, progress) {
  const coords = getRouteCoordinates(routeId);
  if (!coords || !coords.length) {
    return null;
  }

  const clamped = ((progress % 1) + 1) % 1;
  const scaledIndex = clamped * (coords.length - 1);
  const lowerIndex = Math.floor(scaledIndex);
  const upperIndex = Math.min(coords.length - 1, lowerIndex + 1);
  const t = scaledIndex - lowerIndex;

  const [lonA, latA] = coords[lowerIndex];
  const [lonB, latB] = coords[upperIndex];

  return {
    lat: latA + (latB - latA) * t,
    lon: lonA + (lonB - lonA) * t,
  };
}

const BASE = [
  { id: "mock-1", vehicleLabel: "GO 3021", routeId: "LW", progress: 0.18, speed: 45 },
  { id: "mock-2", vehicleLabel: "GO 4102", routeId: "MI", progress: 0.48, speed: 52 },
  { id: "mock-3", vehicleLabel: "GO 2210", routeId: "LE", progress: 0.72, speed: 48 },
  { id: "mock-4", vehicleLabel: "Bus 8842", routeId: "GO-16", progress: 0.34, speed: 33 },
];

export function mockVehicles() {
  const now = Math.floor(Date.now() / 1000);

  return BASE.map((v, index) => {
    const routePosition = sampleRoutePoint(v.routeId, v.progress + (now / 250 + index * 0.13) % 1);
    const point = routePosition ?? { lat: v.lat ?? 43.7, lon: v.lon ?? -79.4 };

    const nextProgress = (v.progress + (now / 5000) * (index % 2 === 0 ? 0.0025 : 0.0032)) % 1;

    return {
      id: v.id,
      vehicleLabel: v.vehicleLabel,
      tripId: `mock-trip-${v.id}`,
      routeId: v.routeId,
      latitude: point.lat,
      longitude: point.lon,
      bearing: (index * 70 + now * 2) % 360,
      speed: v.speed + Math.random() * 8,
      currentStatus: "IN_TRANSIT_TO",
      stopId: null,
      timestamp: now,
      occupancyStatus: null,
      tripUpdate: {
        tripId: `mock-trip-${v.id}`,
        routeId: v.routeId,
        vehicleLabel: v.vehicleLabel,
        stopTimeUpdates: [
          {
            stopId: "NEXT_STOP",
            arrivalDelay: Math.floor(Math.random() * 300) - 60,
            arrivalTime: now + 300,
            departureDelay: null,
            departureTime: null,
            scheduleRelationship: "SCHEDULED",
          },
        ],
      },
      _routeProgress: nextProgress,
    };
  });
}
