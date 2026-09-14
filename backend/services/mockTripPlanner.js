import fs from "node:fs";

const ROUTE_PATTERNS = [
  { shortName: "LW", longName: "Lakeshore West", start: { lat: 43.645195, lon: -79.3806 }, end: { lat: 43.266775, lon: -79.866222 } },
  { shortName: "LE", longName: "Lakeshore East", start: { lat: 43.645195, lon: -79.3806 }, end: { lat: 43.8828, lon: -78.9369 } },
  { shortName: "MI", longName: "Milton", start: { lat: 43.645195, lon: -79.3806 }, end: { lat: 43.5756, lon: -79.7088 } },
  { shortName: "KI", longName: "Kitchener", start: { lat: 43.645195, lon: -79.3806 }, end: { lat: 43.4523, lon: -80.4995 } },
  { shortName: "ST", longName: "Stouffville", start: { lat: 43.645195, lon: -79.3806 }, end: { lat: 43.9709, lon: -79.24999 } },
];

const ROUTE_TIME_PROFILES = {
  LW: { avgSpeedKmh: 58, dwellMinutes: 12, minMinutes: 55 },
  LE: { avgSpeedKmh: 60, dwellMinutes: 12, minMinutes: 60 },
  MI: { avgSpeedKmh: 49, dwellMinutes: 10, minMinutes: 30 },
  KI: { avgSpeedKmh: 62, dwellMinutes: 14, minMinutes: 90 },
  ST: { avgSpeedKmh: 54, dwellMinutes: 10, minMinutes: 40 },
  default: { avgSpeedKmh: 55, dwellMinutes: 12, minMinutes: 35 },
};

const stopsData = JSON.parse(
  fs.readFileSync(new URL("../../frontend/src/data/generated/stops.json", import.meta.url), "utf8")
);

function roundTo(value, digits = 5) {
  return Number(value.toFixed(digits));
}

function normalizeMode(value) {
  return String(value || "TRANSIT,WALK")
    .split(",")
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
}

function buildLeg({ mode, from, to, route, durationMinutes, departure, arrival }) {
  return {
    mode,
    ...(route ? { route } : {}),
    duration: durationMinutes * 60,
    from: {
      name: from.name,
      lat: roundTo(from.lat, 6),
      lon: roundTo(from.lon, 6),
      departure,
    },
    to: {
      name: to.name,
      lat: roundTo(to.lat, 6),
      lon: roundTo(to.lon, 6),
      arrival,
    },
    legGeometry: {
      points: encodePolyline([
        [from.lon, from.lat],
        [to.lon, to.lat],
      ]),
    },
  };
}

function encodePolyline(coords) {
  let encoded = "";
  let previousLat = 0;
  let previousLon = 0;

  for (const [lon, lat] of coords) {
    encoded += encodeValue(Math.round(lat * 1e5) - previousLat);
    encoded += encodeValue(Math.round(lon * 1e5) - previousLon);
    previousLat = Math.round(lat * 1e5);
    previousLon = Math.round(lon * 1e5);
  }

  return encoded;
}

function encodeValue(value) {
  let result = value << 1;
  if (value < 0) {
    result = (~result) << 1;
    result = (~result) >>> 0;
  }

  let encoded = "";

  while (result >= 0x20) {
    encoded += String.fromCharCode((0x20 | (result & 0x1f)) + 63);
    result >>>= 5;
  }

  encoded += String.fromCharCode(result + 63);
  return encoded;
}

function nearestStop(point) {
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const stop of stopsData) {
    const distance = Math.hypot(stop.lat - point.lat, stop.lon - point.lon);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = stop;
    }
  }

  return best;
}

function routeForStations(startStop, endStop) {
  const getRoutes = (stop) =>
    Array.isArray(stop?.routes)
      ? stop.routes.filter((r) => r && r.type === 2).map((r) => r.shortName)
      : [];

  const startRoutes = new Set(getRoutes(startStop));
  const endRoutes = new Set(getRoutes(endStop));

  const shared = [...startRoutes].filter((route) => endRoutes.has(route));
  if (shared.length) return shared[0];

  const preferred = [...getRoutes(startStop), ...getRoutes(endStop)][0];
  return preferred || "LW";
}

function haversineKm(a, b) {
  const toRad = (value) => (value * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(h));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function estimateTravelMinutes({ mode, from, to, hasStartStop = false, hasEndStop = false, routeName = "default" }) {
  const distanceKm = haversineKm(from, to);
  const accessBuffer = (hasStartStop ? 4 : 8) + (hasEndStop ? 4 : 8);
  const profile = ROUTE_TIME_PROFILES[routeName] ?? ROUTE_TIME_PROFILES.default;

  if (mode === "RAIL") {
    const railMinutes = (distanceKm / (profile.avgSpeedKmh / 60)) + profile.dwellMinutes + accessBuffer;
    return clamp(Math.round(railMinutes), profile.minMinutes, 180);
  }

  if (mode === "BUS") {
    const busMinutes = distanceKm / 0.8 + 18 + accessBuffer;
    return clamp(Math.round(busMinutes), 25, 120);
  }

  return clamp(Math.round(distanceKm / 1.4 + 7), 8, 90);
}

function pickRoute(from, to) {
  const deltaLat = Math.abs((to.lat ?? from.lat) - (from.lat ?? to.lat));
  const deltaLon = Math.abs((to.lon ?? from.lon) - (from.lon ?? to.lon));

  if (deltaLat < 0.15 && deltaLon < 0.2) {
    return ROUTE_PATTERNS[0];
  }

  const sorted = [...ROUTE_PATTERNS].sort((a, b) => {
    const aDist = Math.hypot((a.start.lat - from.lat) ** 2 + (a.start.lon - from.lon) ** 2, (a.end.lat - to.lat) ** 2 + (a.end.lon - to.lon) ** 2);
    const bDist = Math.hypot((b.start.lat - from.lat) ** 2 + (b.start.lon - from.lon) ** 2, (b.end.lat - to.lat) ** 2 + (b.end.lon - to.lon) ** 2);
    return aDist - bDist;
  });

  return sorted[0] ?? ROUTE_PATTERNS[0];
}

export function mockTripPlan({ fromLat, fromLon, toLat, toLon, mode, date, time, arriveBy } = {}) {
  const origin = {
    lat: Number(fromLat ?? 43.645195),
    lon: Number(fromLon ?? -79.3806),
    name: "Origin",
  };
  const destination = {
    lat: Number(toLat ?? 43.774),
    lon: Number(toLon ?? -79.466),
    name: "Destination",
  };

  const preferredModes = normalizeMode(mode);
  const hasRail = preferredModes.includes("RAIL") || preferredModes.includes("TRANSIT") || preferredModes.includes("ANY");
  const hasBus = preferredModes.includes("BUS") || preferredModes.includes("TRANSIT") || preferredModes.includes("ANY");

  const originStop = nearestStop(origin);
  const destinationStop = nearestStop(destination);

  const baseStart = new Date();
  if (date && time) {
    const dateTimeString = `${date}T${time}`;
    baseStart.setTime(new Date(dateTimeString).getTime());
  }

  const buildStationItinerary = ({ routeName, routeLongName, fromStop, toStop, departMinutes, durationMinutes, transferCount = 0 }) => {
    const departureTime = new Date(baseStart.getTime() + departMinutes * 60 * 1000);
    const arrivalTime = new Date(baseStart.getTime() + (departMinutes + durationMinutes) * 60 * 1000);

    return {
      duration: durationMinutes * 60,
      startTime: departureTime.toISOString(),
      endTime: arrivalTime.toISOString(),
      walkDistance: 0,
      transfers: transferCount,
      legs: [
        buildLeg({
          mode: "RAIL",
          from: { name: fromStop.name, lat: fromStop.lat, lon: fromStop.lon },
          to: { name: toStop.name, lat: toStop.lat, lon: toStop.lon },
          route: routeName,
          durationMinutes,
          departure: departureTime.toISOString(),
          arrival: arrivalTime.toISOString(),
        }),
      ],
    };
  };

  const routeName = routeForStations(originStop, destinationStop);

  const railDurationMinutes = estimateTravelMinutes({
    mode: "RAIL",
    from: originStop || { lat: origin.lat, lon: origin.lon },
    to: destinationStop || { lat: destination.lat, lon: destination.lon },
    hasStartStop: Boolean(originStop),
    hasEndStop: Boolean(destinationStop),
    routeName,
  });

  const busDurationMinutes = estimateTravelMinutes({
    mode: "BUS",
    from: originStop || { lat: origin.lat, lon: origin.lon },
    to: destinationStop || { lat: destination.lat, lon: destination.lon },
    hasStartStop: Boolean(originStop),
    hasEndStop: Boolean(destinationStop),
    routeName,
  });

  const itineraries = [];

  if (hasRail) {
    const routeMeta = ROUTE_PATTERNS.find((pattern) => pattern.shortName === routeName) ?? ROUTE_PATTERNS[0];
    const departureStation = originStop && originStop.routes?.some((r) => r.shortName === routeName) ? originStop : { name: `${routeName} Station`, lat: routeMeta.start.lat, lon: routeMeta.start.lon };
    const arrivalStation = destinationStop && destinationStop.routes?.some((r) => r.shortName === routeName) ? destinationStop : { name: `${routeMeta.longName} stop`, lat: routeMeta.end.lat, lon: routeMeta.end.lon };

    itineraries.push(
      buildStationItinerary({
        routeName,
        routeLongName: routeMeta.longName,
        fromStop: departureStation,
        toStop: arrivalStation,
        departMinutes: 3,
        durationMinutes: railDurationMinutes,
      })
    );
  }

  if (hasBus) {
    const busRouteName = "GO-16";
    const busFrom = originStop || { name: "City Centre Bus Terminal", lat: origin.lat + 0.0025, lon: origin.lon + 0.001 };
    const busTo = destinationStop || { name: "Destination Terminal", lat: destination.lat - 0.0015, lon: destination.lon - 0.002 };

    itineraries.push({
      duration: busDurationMinutes * 60,
      startTime: new Date(baseStart.getTime() + 5 * 60 * 1000).toISOString(),
      endTime: new Date(baseStart.getTime() + (5 + busDurationMinutes) * 60 * 1000).toISOString(),
      walkDistance: 0,
      transfers: 0,
      legs: [
        buildLeg({
          mode: "BUS",
          from: { name: busFrom.name, lat: busFrom.lat, lon: busFrom.lon },
          to: { name: busTo.name, lat: busTo.lat, lon: busTo.lon },
          route: busRouteName,
          durationMinutes: busDurationMinutes,
          departure: new Date(baseStart.getTime() + 5 * 60 * 1000).toISOString(),
          arrival: new Date(baseStart.getTime() + (5 + busDurationMinutes) * 60 * 1000).toISOString(),
        }),
      ],
    });
  }

  const sortedItineraries = itineraries.sort((a, b) => a.duration - b.duration);

  return {
    plan: {
      from: {
        name: originStop?.name || "Origin",
        lat: roundTo(origin.lat, 6),
        lon: roundTo(origin.lon, 6),
      },
      to: {
        name: destinationStop?.name || "Destination",
        lat: roundTo(destination.lat, 6),
        lon: roundTo(destination.lon, 6),
      },
      itineraries: sortedItineraries,
    },
  };
}
