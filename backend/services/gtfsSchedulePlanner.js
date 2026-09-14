import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FEEDS = ["go", "up"];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }

  const header = rows.shift()?.map((value) => value.replace(/^\uFEFF/, "")) ?? [];
  return rows.map((values) =>
    Object.fromEntries(header.map((key, index) => [key, values[index] ?? ""]))
  );
}

function readRows(feed, file) {
  const filePath = path.join(ROOT, "data", "gtfs", feed, file);
  if (!fs.existsSync(filePath)) return [];
  return parseCsv(fs.readFileSync(filePath, "utf8"));
}

function minutesFromGtfsTime(value) {
  const [hours, minutes, seconds] = String(value).split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes + (seconds || 0) / 60;
}

function dateWithMinutes(date, minutes) {
  const result = new Date(`${date}T00:00:00`);
  result.setMinutes(minutes);
  return result;
}

function formatScheduleTime(minutes) {
  const totalMinutes = Math.round(minutes);
  const hours = Math.floor(totalMinutes / 60) % 24;
  const mins = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function scheduleDateTime(date, minutes) {
  return `${date}T${formatScheduleTime(minutes)}:00`;
}

function torontoNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Toronto",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(new Date())
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function distanceKm(a, b) {
  const radians = Math.PI / 180;
  const dLat = (b.lat - a.lat) * radians;
  const dLon = (b.lon - a.lon) * radians;
  const lat1 = a.lat * radians;
  const lat2 = b.lat * radians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function loadFeed(feed) {
  const serviceDates = new Map();
  for (const row of readRows(feed, "calendar_dates.txt")) {
    if (row.exception_type === "1") {
      const dates = serviceDates.get(row.service_id) ?? new Set();
      dates.add(row.date);
      serviceDates.set(row.service_id, dates);
    }
  }
  const routes = new Map(
    readRows(feed, "routes.txt").map((route) => [
      route.route_id,
      {
        id: route.route_id,
        shortName: route.route_short_name || route.route_long_name || route.route_id,
        longName: route.route_long_name || route.route_short_name || route.route_id,
        type: Number(route.route_type),
      },
    ])
  );
  const stops = new Map(
    readRows(feed, "stops.txt")
      .filter((stop) => stop.stop_lat && stop.stop_lon)
      .map((stop) => [
        stop.stop_id,
        { id: stop.stop_id, name: stop.stop_name, lat: Number(stop.stop_lat), lon: Number(stop.stop_lon) },
      ])
  );
  const trips = new Map(
    readRows(feed, "trips.txt").map((trip) => [
      trip.trip_id,
      { id: trip.trip_id, serviceId: trip.service_id, route: routes.get(trip.route_id), stopTimes: [] },
    ])
  );

  for (const stopTime of readRows(feed, "stop_times.txt")) {
    const trip = trips.get(stopTime.trip_id);
    const stop = stops.get(stopTime.stop_id);
    if (!trip || !stop) continue;
    const arrival = minutesFromGtfsTime(stopTime.arrival_time);
    const departure = minutesFromGtfsTime(stopTime.departure_time);
    if (arrival == null || departure == null) continue;
    trip.stopTimes.push({
      stop,
      sequence: Number(stopTime.stop_sequence),
      arrival,
      departure,
    });
  }

  for (const trip of trips.values()) {
    for (const stopTime of trip.stopTimes) {
      stopTime.stop.routeTypes ??= new Set();
      stopTime.stop.routeTypes.add(trip.route.type);
    }
  }

  return { routes, stops: [...stops.values()], trips: [...trips.values()], serviceDates };
}

const feeds = FEEDS.map(loadFeed);
const allStops = feeds.flatMap((feed) => feed.stops);
const tripsByStopId = new Map();
for (const feed of feeds) {
  for (const trip of feed.trips) {
    for (const stopTime of trip.stopTimes) {
      const entries = tripsByStopId.get(stopTime.stop.id) ?? [];
      entries.push({ trip, stopTime });
      tripsByStopId.set(stopTime.stop.id, entries);
    }
  }
}

function nearestStop(point, allowedType) {
  return allStops
    .filter((stop) => !allowedType || stop.routeTypes?.has(allowedType))
    .map((stop) => ({ stop, distance: distanceKm(point, stop) }))
    .sort((a, b) => a.distance - b.distance)[0]?.stop;
}

function nearbyStops(point, allowedType, limit = 4) {
  return allStops
    .filter((stop) => !allowedType || stop.routeTypes?.has(allowedType))
    .map((stop) => ({ stop, distance: distanceKm(point, stop) }))
    .filter(({ distance }) => distance <= 12)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map(({ stop }) => stop);
}

function findDirectTrips(from, to, modeType) {
  const trips = [];
  for (const feed of feeds) {
    for (const trip of feed.trips) {
      if (!trip.route || trip.route.type !== modeType) continue;
      const fromTime = trip.stopTimes.find((time) => time.stop.id === from.id);
      const toTime = trip.stopTimes.find((time) => time.stop.id === to.id && time.sequence > fromTime?.sequence);
      if (!fromTime || !toTime) continue;
      trips.push({ trip, fromTime, toTime });
    }
  }
  return trips;
}

function findTransferTrips(from, to, modeTypes, requested, arriveBy) {
  const candidates = [];
  const firstTrips = (tripsByStopId.get(from.id) ?? [])
    .filter(({ trip }) => trip.route && modeTypes.includes(trip.route.type))
    .filter(({ stopTime }) => arriveBy || stopTime.departure >= requested)
    .sort((a, b) => arriveBy ? b.stopTime.departure - a.stopTime.departure : a.stopTime.departure - b.stopTime.departure)
    .slice(0, 24);

  for (const { trip: first, stopTime: firstFrom } of firstTrips) {
    for (const transfer of first.stopTimes.slice(0, 50)) {
      if (transfer.sequence <= firstFrom.sequence) continue;
      const secondTrips = (tripsByStopId.get(transfer.stop.id) ?? [])
        .filter(({ stopTime }) => stopTime.departure >= transfer.arrival + 5)
        .slice(0, 50);
      for (const { trip: second, stopTime: secondTransfer } of secondTrips) {
        if (!second.route || !modeTypes.includes(second.route.type)) continue;
        if (second.id === first.id || (second.route.type === first.route.type && second.route.id === first.route.id)) continue;
        const secondTo = second.stopTimes.find(
          (time) => time.stop.id === to.id && time.sequence > secondTransfer.sequence
        );
        if (!secondTo || secondTransfer.departure < transfer.arrival + 5) continue;
        if (arriveBy && secondTo.arrival > requested) continue;
        candidates.push({ first, firstFrom, transfer, second, secondTransfer, secondTo });
      }
    }
  }
  return candidates;
}

function buildItinerary(candidate, date, requestedMinutes, arriveBy) {
  if (candidate.first) {
    const firstStart = dateWithMinutes(date, candidate.firstFrom.departure);
    const firstEnd = dateWithMinutes(date, candidate.transfer.arrival);
    const secondStart = dateWithMinutes(date, candidate.secondTransfer.departure);
    const secondEnd = dateWithMinutes(date, candidate.secondTo.arrival);
    const legs = [
      {
        mode: candidate.first.route.type === 2 ? "RAIL" : "BUS",
        route: candidate.first.route.shortName,
        routeLongName: candidate.first.route.longName,
        duration: Math.round((firstEnd - firstStart) / 1000),
        from: { name: candidate.firstFrom.stop.name, lat: candidate.firstFrom.stop.lat, lon: candidate.firstFrom.stop.lon, departure: scheduleDateTime(date, candidate.firstFrom.departure) },
        to: { name: candidate.transfer.stop.name, lat: candidate.transfer.stop.lat, lon: candidate.transfer.stop.lon, arrival: scheduleDateTime(date, candidate.transfer.arrival) },
      },
      {
        mode: candidate.second.route.type === 2 ? "RAIL" : "BUS",
        route: candidate.second.route.shortName,
        routeLongName: candidate.second.route.longName,
        duration: Math.round((secondEnd - secondStart) / 1000),
        from: { name: candidate.secondTransfer.stop.name, lat: candidate.secondTransfer.stop.lat, lon: candidate.secondTransfer.stop.lon, departure: scheduleDateTime(date, candidate.secondTransfer.departure) },
        to: { name: candidate.secondTo.stop.name, lat: candidate.secondTo.stop.lat, lon: candidate.secondTo.stop.lon, arrival: scheduleDateTime(date, candidate.secondTo.arrival) },
      },
    ];
    return {
      duration: Math.round((secondEnd - firstStart) / 1000),
      startTime: scheduleDateTime(date, candidate.firstFrom.departure),
      endTime: scheduleDateTime(date, candidate.secondTo.arrival),
      walkDistance: 0,
      transfers: 1,
      source: "static-gtfs",
      legs,
    };
  }

  const { trip, fromTime, toTime } = candidate;
  const scheduleMinutes = arriveBy ? toTime.arrival : fromTime.departure;
  const dayOffset = arriveBy
    ? scheduleMinutes <= requestedMinutes ? 0 : -1
    : scheduleMinutes >= requestedMinutes ? 0 : 1;
  const serviceDate = new Date(`${date}T00:00:00`);
  serviceDate.setDate(serviceDate.getDate() + dayOffset);
  const serviceDateString = serviceDate.toISOString().slice(0, 10);
  const departure = dateWithMinutes(serviceDateString, fromTime.departure);
  const arrival = dateWithMinutes(serviceDateString, toTime.arrival);

  return {
    duration: Math.max(0, Math.round((arrival - departure) / 1000)),
    startTime: scheduleDateTime(serviceDateString, fromTime.departure),
    endTime: scheduleDateTime(serviceDateString, toTime.arrival),
    walkDistance: 0,
    transfers: 0,
    source: "static-gtfs",
    legs: [{
      mode: trip.route.type === 2 ? "RAIL" : "BUS",
      route: trip.route.shortName,
      routeLongName: trip.route.longName,
      duration: Math.max(0, Math.round((arrival - departure) / 1000)),
      from: { name: fromTime.stop.name, lat: fromTime.stop.lat, lon: fromTime.stop.lon, departure: scheduleDateTime(serviceDateString, fromTime.departure) },
      to: { name: toTime.stop.name, lat: toTime.stop.lat, lon: toTime.stop.lon, arrival: scheduleDateTime(serviceDateString, toTime.arrival) },
    }],
  };
}

export function staticGtfsPlan({ fromLat, fromLon, toLat, toLon, mode, date, time, arriveBy } = {}) {
  const origin = { lat: Number(fromLat), lon: Number(fromLon) };
  const destination = { lat: Number(toLat), lon: Number(toLon) };
  if (![origin.lat, origin.lon, destination.lat, destination.lon].every(Number.isFinite)) return null;

  const modes = String(mode || "TRANSIT").split(",").map((value) => value.trim().toUpperCase());
  const modeTypes = modes.includes("RAIL") && !modes.includes("BUS")
    ? [2]
    : modes.includes("BUS") && !modes.includes("RAIL")
      ? [3]
      : [2, 3];
  const now = torontoNow();
  const requestedDate = date || now.date;
  const requested = time ? minutesFromGtfsTime(`${time}:00`) : now.minutes;
  const itineraries = [];

  for (const modeType of modeTypes) {
    const fromStops = nearbyStops(origin, modeType);
    const toStops = nearbyStops(destination, modeType);
    if (!fromStops.length || !toStops.length) continue;
    const directCandidates = fromStops.flatMap((from) =>
      toStops.flatMap((to) => findDirectTrips(from, to, modeType))
    );
    const candidates = directCandidates
      .sort((a, b) => (arriveBy ? b.toTime.arrival - a.toTime.arrival : a.fromTime.departure - b.fromTime.departure));
    const selected = candidates.filter((candidate) => {
      const scheduled = arriveBy ? candidate.toTime.arrival : candidate.fromTime.departure;
      return arriveBy ? scheduled <= requested || scheduled > requested + 24 * 60 : scheduled >= requested;
    }).slice(0, 3);
    const seenSchedules = new Set();
    selected.forEach((candidate) => {
      const key = `${candidate.trip.route.id}:${candidate.fromTime.departure}:${candidate.toTime.arrival}`;
      if (seenSchedules.has(key)) return;
      seenSchedules.add(key);
      itineraries.push(buildItinerary(candidate, requestedDate, requested, arriveBy));
    });

    const transferCandidates = fromStops.slice(0, 2).flatMap((from) =>
      toStops.slice(0, 2).flatMap((to) => findTransferTrips(from, to, modeTypes, requested, arriveBy))
    )
      .sort((a, b) => arriveBy ? b.secondTo.arrival - a.secondTo.arrival : a.secondTo.arrival - b.secondTo.arrival)
      .slice(0, 5);
      const seenTransfers = new Set();
      transferCandidates.forEach((candidate) => {
        const key = [
          candidate.first.route.id,
          candidate.firstFrom.departure,
          candidate.transfer.stop.id,
          candidate.second.route.id,
          candidate.secondTo.arrival,
        ].join(":");
        if (seenTransfers.has(key)) return;
        seenTransfers.add(key);
        if (itineraries.length < 5) itineraries.push(buildItinerary(candidate, requestedDate, requested, arriveBy));
      });
  }

  itineraries.sort((a, b) => a.duration - b.duration);
  return { plan: { from: origin, to: destination, itineraries }, source: "static-gtfs" };
}
