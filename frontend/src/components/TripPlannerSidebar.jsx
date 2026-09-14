import { useRef, useState } from "react";
import StationSearch from "./StationSearch.jsx";
import linesGeoJson from "../data/generated/lines.json";

const RAIL_ROUTE_NAMES = {
  LW: "Lakeshore West",
  LE: "Lakeshore East",
  MI: "Milton",
  KI: "Kitchener",
  BR: "Barrie",
  RH: "Richmond Hill",
  ST: "Stouffville",
  UP: "Union Pearson Express",
};

function coordinateDistance(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function clippedRouteShape(route, from, to) {
  const routeName = RAIL_ROUTE_NAMES[route];
  const fromCoordinate = [Number(from?.lon), Number(from?.lat)];
  const toCoordinate = [Number(to?.lon), Number(to?.lat)];
  if (![...fromCoordinate, ...toCoordinate].every(Number.isFinite)) return [];

  const candidates = linesGeoJson.features.filter((feature) => {
    const properties = feature.properties || {};
    return (
      properties.shortName === route ||
      properties.routeId?.endsWith(`-${route}`) ||
      properties.name === routeName
    );
  });

  let best = null;
  for (const feature of candidates) {
    const coordinates = feature.geometry?.coordinates || [];
    if (coordinates.length < 2) continue;
    const fromIndex = coordinates.reduce(
      (bestIndex, coordinate, index) =>
        coordinateDistance(coordinate, fromCoordinate) < coordinateDistance(coordinates[bestIndex], fromCoordinate)
          ? index
          : bestIndex,
      0
    );
    const toIndex = coordinates.reduce(
      (bestIndex, coordinate, index) =>
        coordinateDistance(coordinate, toCoordinate) < coordinateDistance(coordinates[bestIndex], toCoordinate)
          ? index
          : bestIndex,
      0
    );
    const forward = fromIndex <= toIndex
      ? coordinates.slice(fromIndex, toIndex + 1)
      : coordinates.slice(toIndex, fromIndex + 1).reverse();
    const score = coordinateDistance(coordinates[fromIndex], fromCoordinate) + coordinateDistance(coordinates[toIndex], toCoordinate);
    if (!best || score < best.score) best = { coordinates: forward, score };
  }

  if (!best || best.coordinates.length < 2) return [];
  return [fromCoordinate, ...best.coordinates, toCoordinate];
}

function decodePolyline(encoded) {
  if (!encoded) return [];

  let index = 0;
  const len = encoded.length;
  let lat = 0;
  let lon = 0;
  const coordinates = [];

  while (index < len) {
    let b;
    let shift = 0;
    let result = 0;

    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    const deltaLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += deltaLat;

    shift = 0;
    result = 0;

    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    const deltaLon = result & 1 ? ~(result >> 1) : result >> 1;
    lon += deltaLon;

    coordinates.push([lon / 1e5, lat / 1e5]);
  }

  return coordinates;
}

function polylineToGeoJson(legs, options = {}) {
  const { selected = true } = options;
  const features = [];
  const previousModeByStop = { current: null };

  (legs || []).forEach((leg, legIndex) => {
    const scheduledShape = !leg.legGeometry?.points && (leg.mode === "RAIL" || leg.mode === "BUS")
      ? clippedRouteShape(leg.route, leg.from, leg.to)
      : [];
    const legCoordinates = leg.legGeometry?.points
      ? decodePolyline(leg.legGeometry.points)
      : scheduledShape.length > 1
        ? scheduledShape
        : leg.mode === "BUS" && leg.from?.lon != null && leg.to?.lon != null
          ? [[leg.from.lon, leg.from.lat], [leg.to.lon, leg.to.lat]]
          : [];

    if (legCoordinates.length > 1) {
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: legCoordinates,
        },
        properties: {
          mode: leg.mode,
          route: leg.route ?? "",
          color:
            leg.mode === "RAIL"
              ? ({ LW: "#98002e", LE: "#ff0d00", MI: "#f57f25", KI: "#00853e", BR: "#003767", RH: "#0099c7", ST: "#794500", UP: "#0075D2" }[leg.route] || "#1f8a3b")
              : leg.mode === "BUS" ? "#7a4fa3" : "#0a6efc",
          selected,
          approximate: leg.mode === "BUS" && !leg.legGeometry?.points && scheduledShape.length < 2,
        },
      });
    }

    const transferFrom = legIndex > 0 && previousModeByStop.current && leg.mode !== previousModeByStop.current && leg.mode !== "WALK";
    const startStop = leg.from || {};
    const endStop = leg.to || {};

    if (startStop.lon != null && startStop.lat != null) {
      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [startStop.lon, startStop.lat],
        },
        properties: {
          mode: leg.mode,
          label: startStop.name || `${leg.mode} stop`,
          time: startStop.departure || startStop.arrival || null,
          transfer: transferFrom,
          selected,
          location: `${Number(startStop.lat).toFixed(4)}, ${Number(startStop.lon).toFixed(4)}`,
        },
      });
    }

    if (endStop.lon != null && endStop.lat != null) {
      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [endStop.lon, endStop.lat],
        },
        properties: {
          mode: leg.mode,
          label: endStop.name || `${leg.mode} stop`,
          time: endStop.arrival || endStop.departure || null,
          transfer: legIndex < (legs || []).length - 1 && leg.mode !== "WALK" && leg.mode !== (legs[legIndex + 1]?.mode ?? "WALK"),
          selected,
          location: `${Number(endStop.lat).toFixed(4)}, ${Number(endStop.lon).toFixed(4)}`,
        },
      });
    }

    previousModeByStop.current = leg.mode;
  });

  return { type: "FeatureCollection", features };
}

export default function TripPlannerSidebar({
  open,
  onClose,
  origin,
  destination,
  onSetOrigin,
  onSetDestination,
  onStartPicking,
  onPlanReady,
  mapLayers,
  onToggleMapLayer,
}) {
  const [timeMode, setTimeMode] = useState("depart"); // "depart" | "arrive"
  const [transportPreference, setTransportPreference] = useState("any"); // "any" | "rail" | "bus"
  const [dateTime, setDateTime] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [itineraries, setItineraries] = useState([]);
  const [selectedItineraryIndex, setSelectedItineraryIndex] = useState(null);
  const [dateMenuOpen, setDateMenuOpen] = useState(false);
  const dateInputRef = useRef(null);
  const timeInputRef = useRef(null);

  const canPlan = origin && destination;

  function swapLocations() {
    if (!origin && !destination) return;
    const previousOrigin = origin;
    onSetOrigin(destination || null);
    onSetDestination(previousOrigin || null);
  }

  function formatDateTime(value) {
    if (!value) return "Choose date and time";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? "Choose date and time"
      : parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }

  function localDateString() {
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60000;
    return new Date(now.getTime() - offset).toISOString().slice(0, 10);
  }

  function openPicker(ref) {
    if (typeof ref.current?.showPicker === "function") ref.current.showPicker();
    else ref.current?.click();
  }

  function getVisibleLegs(itinerary) {
    return (itinerary?.legs || []).filter((leg) => {
      if (leg.mode !== "WALK") return true;
      const text = `${leg.from?.name || ""} ${leg.to?.name || ""}`.toLowerCase();
      return !/(station|stop|go|terminal|platform)/i.test(text);
    });
  }

  function transitIcon(mode) {
    if (mode === "RAIL") return "🚆";
    if (mode === "BUS") return "🚌";
    if (mode === "WALK") return "🚶";
    return "•";
  }

  function formatLegTime(value) {
    if (!value) return "";
    const match = value.match(/T(\d{2}):(\d{2})/);
    if (!match) return "";
    const hour = Number(match[1]);
    return `${hour % 12 || 12}:${match[2]} ${hour >= 12 ? "PM" : "AM"}`;
  }

  function updateTripSelection(nextIndex) {
    const nextSelection = selectedItineraryIndex === nextIndex ? null : nextIndex;
    setSelectedItineraryIndex(nextSelection);

    if (nextSelection == null) {
      onPlanReady?.(null);
      return;
    }

    const selectedPlan = itineraries[nextSelection];
    if (selectedPlan) {
      onPlanReady?.(polylineToGeoJson(getVisibleLegs(selectedPlan), { selected: true }));
    }
  }

  async function handlePlan() {
    setLoading(true);
    setError(null);
    setItineraries([]);
    setSelectedItineraryIndex(null);

    const [date, time] = dateTime ? dateTime.split("T") : [undefined, undefined];
    const modePreference =
      transportPreference === "rail"
        ? "RAIL,WALK"
        : transportPreference === "bus"
          ? "BUS,WALK"
          : "TRANSIT,WALK";

    const params = new URLSearchParams({
      fromLat: origin.lat,
      fromLon: origin.lon,
      toLat: destination.lat,
      toLon: destination.lon,
      mode: modePreference,
      arriveBy: timeMode === "arrive" ? "true" : "false",
      ...(date ? { date } : {}),
      ...(time ? { time } : {}),
    });

    try {
      const res = await fetch(`/api/plan?${params.toString()}`);
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Trip planning isn't available yet.");
        return;
      }

      const plans = data.plan?.itineraries ?? [];
      setItineraries(plans);

      if (plans[0]) {
        setSelectedItineraryIndex(0);
        onPlanReady?.(polylineToGeoJson(getVisibleLegs(plans[0]), { selected: true }));
      } else {
        onPlanReady?.(null);
        setError(
          data.source === "static-gtfs"
            ? "No direct scheduled train or bus trip was found for these stops and time. Try another time or enable Any."
            : "No trips were found for these locations."
        );
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {/* Pull-out tab, always visible so the panel can be reopened */}
      <button
        className={`sidebar-tab ${open ? "sidebar-open" : ""}`}
        onClick={onClose}
        aria-label={open ? "Collapse trip planner" : "Open trip planner"}
      >
        {open ? "‹" : "Plan a trip ›"}
      </button>

      <aside className={`trip-sidebar ${open ? "open" : "closed"}`}>
        <h2>Trip Planner</h2>

        <div className="location-fields">
          <div className="field">
            <label>Origin</label>
            <StationSearch
              placeholder="Search a station or bus terminal…"
              value={origin}
              onSelect={onSetOrigin}
              onPickOnMap={() => onStartPicking("origin")}
            />
          </div>

          <button
            type="button"
            className="swap-locations"
            onClick={swapLocations}
            disabled={!origin && !destination}
            aria-label="Swap origin and destination"
            title="Swap origin and destination"
          >
            ⇅
          </button>

          <div className="field">
            <label>Destination</label>
            <StationSearch
              placeholder="Search a station or bus terminal…"
              value={destination}
              onSelect={onSetDestination}
              onPickOnMap={() => onStartPicking("destination")}
            />
          </div>
        </div>

        <div className="field">
          <label>Choose date and time</label>
          <div className="time-toggle">
            <button className={timeMode === "depart" ? "active" : ""} onClick={() => setTimeMode("depart")}>
              Depart at
            </button>
            <button className={timeMode === "arrive" ? "active" : ""} onClick={() => setTimeMode("arrive")}>
              Arrive by
            </button>
          </div>
          <button
            type="button"
            className={`date-time-trigger ${dateTime ? "has-value" : ""}`}
            onClick={() => setDateMenuOpen((open) => !open)}
            aria-expanded={dateMenuOpen}
          >
            <span className="date-time-icon" aria-hidden="true">▣</span>
            {formatDateTime(dateTime)}
          </button>
          <div className={`date-time-menu ${dateMenuOpen ? "open" : ""}`}>
            <div className="date-time-option">
              <span>Date</span>
              <button type="button" onClick={() => openPicker(dateInputRef)}>
                {dateTime.split("T")[0] || "Choose date"}
              </button>
              <input
                ref={dateInputRef}
                type="date"
                value={dateTime.split("T")[0] || ""}
                onChange={(e) => setDateTime(`${e.target.value}T${dateTime.split("T")[1] || "08:00"}`)}
              />
            </div>
            <div className="date-time-option">
              <span>Time</span>
              <button type="button" onClick={() => openPicker(timeInputRef)}>
                {dateTime.split("T")[1] || "Choose time"}
              </button>
              <input
                ref={timeInputRef}
                type="time"
                value={dateTime.split("T")[1] || ""}
                onChange={(e) => setDateTime(`${dateTime.split("T")[0] || localDateString()}T${e.target.value}`)}
              />
            </div>
            <button type="button" className="date-time-done" onClick={() => setDateMenuOpen(false)}>
              Done
            </button>
          </div>
        </div>

        <div className="field">
          <label>Preferred transit</label>
          <div className="transport-toggle">
            <button className={transportPreference === "any" ? "active" : ""} onClick={() => setTransportPreference("any")}>
              Any
            </button>
            <button className={transportPreference === "rail" ? "active" : ""} onClick={() => setTransportPreference("rail")}>
              Rail
            </button>
            <button className={transportPreference === "bus" ? "active" : ""} onClick={() => setTransportPreference("bus")}>
              Bus
            </button>
          </div>
        </div>

        <button className="plan-btn" disabled={!canPlan || loading} onClick={handlePlan}>
          {loading ? <><span className="planning-spinner" aria-hidden="true" /> Planning…</> : "Find fastest trip"}
        </button>

        <div className="map-layer-menu">
          <div className="map-layer-title">Map layers</div>
          <label className="layer-toggle">
            <input
              type="checkbox"
              checked={mapLayers?.goStations ?? true}
              onChange={() => onToggleMapLayer?.("goStations")}
            />
            <span>GO stations</span>
          </label>
          <label className="layer-toggle">
            <input
              type="checkbox"
              checked={mapLayers?.busStops ?? true}
              onChange={() => onToggleMapLayer?.("busStops")}
            />
            <span>Bus stops</span>
          </label>
          <label className="layer-toggle">
            <input
              type="checkbox"
              checked={mapLayers?.trainLines ?? true}
              onChange={() => onToggleMapLayer?.("trainLines")}
            />
            <span>Train lines</span>
          </label>
          <label className="layer-toggle">
            <input
              type="checkbox"
              checked={mapLayers?.tripRoute ?? true}
              onChange={() => onToggleMapLayer?.("tripRoute")}
            />
            <span>Selected trip</span>
          </label>
        </div>

        {error && <p className="error">{error}</p>}

        {itineraries.length > 0 && (
          <ul className="itineraries">
            {itineraries.map((it, i) => {
              const isSelected = selectedItineraryIndex === i;
              const visibleLegs = getVisibleLegs(it);
              const routeSummary = visibleLegs
                .map((leg) => leg.route || leg.mode)
                .join(" → ") || it.legs.map((leg) => leg.mode).join(" → ");

              return (
                <li key={i} className={isSelected ? "itinerary-item selected" : "itinerary-item"}>
                  <button
                    type="button"
                    className={isSelected ? "itinerary-button selected" : "itinerary-button"}
                    onClick={() => updateTripSelection(i)}
                  >
                    <span className="itinerary-mainline">
                      <strong>{Math.round(it.duration / 60)} min</strong>
                      <span>
                        {" · "}
                        {visibleLegs.map((leg) => `${transitIcon(leg.mode)} ${leg.mode === "RAIL" ? leg.route || "Train" : leg.mode === "BUS" ? leg.route || "Bus" : "Walk"}`).join(" → ") || "Transit"}
                      </span>
                    </span>
                    <span className="itinerary-meta">
                      {it.transfers} transfer{it.transfers === 1 ? "" : "s"}
                    </span>
                  </button>

                  {isSelected && (
                    <div className="itinerary-details">
                      <div className="selected-trip-summary">
                        <div className="selected-trip-title">
                          {it.legs?.[0]?.from?.name || "Origin"} <span>→</span> {it.legs?.[it.legs.length - 1]?.to?.name || "Destination"}
                        </div>
                        <div className="selected-trip-stats">
                          <strong>{formatLegTime(it.startTime)} – {formatLegTime(it.endTime)}</strong>
                          <span>{Math.round(it.duration / 60)} min · {it.transfers} transfer{it.transfers === 1 ? "" : "s"}</span>
                        </div>
                      </div>
                      <div className="itinerary-route">
                        <span className="details-label">Route</span>
                        <span>{routeSummary}</span>
                      </div>

                      {visibleLegs.map((leg, legIndex) => {
                        const modeLabel = leg.mode === "WALK" ? "Walk" : leg.mode === "RAIL" ? "Train" : leg.mode === "BUS" ? "Bus" : leg.mode;
                        const fromName = leg.from?.name || "Start";
                        const toName = leg.to?.name || "Destination";
                        const isTransfer = legIndex > 0 && leg.mode !== "WALK";
                        const instruction =
                          leg.mode === "RAIL"
                            ? `Board GO ${leg.route || "train"} at ${fromName}. Get off at ${toName}.`
                            : leg.mode === "BUS"
                              ? `Board ${leg.route || "GO bus"} at ${fromName}. Get off at ${toName}.`
                              : `${fromName} → ${toName}`;

                        const previousLeg = visibleLegs[legIndex - 1];
                        const transferMinutes =
                          previousLeg && leg.from?.departure && previousLeg.to?.arrival
                            ? Math.max(0, Math.round((new Date(`1970-01-01T${leg.from.departure.slice(11, 16)}:00`) - new Date(`1970-01-01T${previousLeg.to.arrival.slice(11, 16)}:00`)) / 60000))
                            : null;

                        return (
                          <div key={`${i}-${legIndex}`}>
                            {transferMinutes != null && (
                              <div className="transfer-connector">
                                <span className="transfer-connector-line" />
                                <span>Transfer at {fromName} · {transferMinutes} min</span>
                              </div>
                            )}
                            <div className="timeline-step">
                              <div className={`timeline-marker ${isTransfer ? "transfer" : ""}`}>{legIndex + 1}</div>
                              <div className="itinerary-step">
                                <div className="step-mode">
                                  {transitIcon(leg.mode)} {modeLabel} {leg.route && <span className="route-badge">{leg.route}</span>}
                                </div>
                                <div className="step-copy">
                                  <div>
                                    {formatLegTime(leg.from?.departure)} – {formatLegTime(leg.to?.arrival)} · {instruction}
                                  </div>
                                  {isTransfer && <div className="transfer-badge">Transfer leg</div>}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </aside>
    </>
  );
}
