import fetch from "node-fetch";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const { transit_realtime: transitRealtime } = GtfsRealtimeBindings;

/**
 * Fetches a GTFS-RT protobuf feed and decodes it into plain JS objects.
 * GTFS-RT is delivered as binary protobuf, not JSON — that's the main gotcha
 * people hit the first time they touch a feed like this.
 */
async function fetchFeed(url, apiKey) {
  const res = await fetch(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });

  if (!res.ok) {
    throw new Error(`GTFS-RT fetch failed (${res.status}) for ${url}`);
  }

  const buffer = await res.arrayBuffer();
  const feed = transitRealtime.FeedMessage.decode(new Uint8Array(buffer));
  return feed.entity ?? [];
}

/**
 * Normalizes a VehiclePositions feed entity into the shape the frontend wants.
 */
function normalizeVehicle(entity) {
  const v = entity.vehicle;
  if (!v || !v.position) return null;

  return {
    id: entity.id,
    vehicleLabel: v.vehicle?.label ?? v.vehicle?.id ?? entity.id,
    tripId: v.trip?.tripId ?? null,
    routeId: v.trip?.routeId ?? null,
    latitude: v.position.latitude,
    longitude: v.position.longitude,
    bearing: v.position.bearing ?? null,
    speed: v.position.speed ?? null,
    currentStatus: v.currentStatus ?? null,
    stopId: v.stopId ?? null,
    timestamp: v.timestamp ? Number(v.timestamp) : null,
    occupancyStatus: v.occupancyStatus ?? null,
  };
}

/**
 * Normalizes a TripUpdates feed entity — useful for the hover popup
 * (next stop, delay, scheduled vs predicted time).
 */
function normalizeTripUpdate(entity) {
  const t = entity.tripUpdate;
  if (!t) return null;

  return {
    tripId: t.trip?.tripId ?? null,
    routeId: t.trip?.routeId ?? null,
    vehicleLabel: t.vehicle?.label ?? t.vehicle?.id ?? null,
    stopTimeUpdates: (t.stopTimeUpdate ?? []).map((s) => ({
      stopId: s.stopId,
      arrivalDelay: s.arrival?.delay ?? null,
      arrivalTime: s.arrival?.time ? Number(s.arrival.time) : null,
      departureDelay: s.departure?.delay ?? null,
      departureTime: s.departure?.time ? Number(s.departure.time) : null,
      scheduleRelationship: s.scheduleRelationship ?? null,
    })),
  };
}

export async function pollOnce({ vehicleUrl, tripUpdatesUrl, apiKey }) {
  const [vehicleEntities, tripEntities] = await Promise.all([
    fetchFeed(vehicleUrl, apiKey),
    tripUpdatesUrl ? fetchFeed(tripUpdatesUrl, apiKey) : Promise.resolve([]),
  ]);

  const vehicles = vehicleEntities.map(normalizeVehicle).filter(Boolean);
  const tripUpdates = tripEntities.map(normalizeTripUpdate).filter(Boolean);

  // Merge trip update info (delay, next stop) onto each vehicle by tripId,
  // so the frontend gets one flat object per vehicle for the hover popup.
  const tripUpdateByTripId = new Map(tripUpdates.map((t) => [t.tripId, t]));
  const merged = vehicles.map((v) => ({
    ...v,
    tripUpdate: v.tripId ? tripUpdateByTripId.get(v.tripId) ?? null : null,
  }));

  return merged;
}

/**
 * Starts an interval that polls Metrolinx and calls onUpdate(vehicles) each time.
 * Returns a stop() function.
 */
export function startPolling({ vehicleUrl, tripUpdatesUrl, apiKey, intervalMs, onUpdate, onError }) {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const vehicles = await pollOnce({ vehicleUrl, tripUpdatesUrl, apiKey });
      onUpdate(vehicles);
    } catch (err) {
      onError?.(err);
    } finally {
      if (!stopped) setTimeout(tick, intervalMs);
    }
  };

  tick();

  return () => {
    stopped = true;
  };
}
