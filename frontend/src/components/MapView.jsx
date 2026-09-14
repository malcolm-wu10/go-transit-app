import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import linesGeoJson from "../data/generated/lines.json";
import stopsData from "../data/generated/stops.json";

const MAP_STYLES = {
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
};

const GTA_CENTER = [-79.42, 43.7];

const SOURCE_IDS = ["go-lines", "stations", "vehicles", "trip-route"];
const LAYER_IDS = [
  "go-lines-casing",
  "go-lines-layer",
  "go-lines-labels",
  "stations-rail-layer",
  "stations-bus-layer",
  "trip-route-layer",
  "vehicles-layer",
];

const stationsGeoJson = {
  type: "FeatureCollection",
  features: stopsData.map((s) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [s.lon, s.lat] },
    properties: {
      id: s.id,
      name: s.name,
      isRail: s.routes.some((r) => r.type === 2),
      routesJson: JSON.stringify(s.routes),
    },
  })),
};

function routeColor(routeId) {
  const colors = {
    LW: "#1f8a3b",
    LE: "#1f8a3b",
    MI: "#7a4fa3",
    KI: "#00a1de",
    BR: "#f4a900",
    RH: "#8b5e3c",
    ST: "#e01f26",
    UP: "#00a99d",
  };
  return colors[routeId] || "#999999";
}

function buildVehicleFeatures(vehicles, selectedVehicleId) {
  return vehicles.map((v) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [v.longitude, v.latitude] },
    properties: {
      id: v.id,
      vehicleLabel: v.vehicleLabel,
      routeId: v.routeId,
      speed: v.speed,
      color: v.id === selectedVehicleId ? "#ff2d55" : routeColor(v.routeId),
      arrivalDelay: v.tripUpdate?.stopTimeUpdates?.[0]?.arrivalDelay ?? null,
    },
  }));
}

function emptyCollection() {
  return { type: "FeatureCollection", features: [] };
}

function vehicleCollection(vehiclesData) {
  return {
    type: "FeatureCollection",
    features: buildVehicleFeatures(vehiclesData.vehicles, vehiclesData.selectedVehicleId),
  };
}

function labelFont(map) {
  const layers = map.getStyle()?.layers ?? [];
  for (const layer of layers) {
    const font = layer.layout?.["text-font"];
    if (Array.isArray(font) && font.length) return font;
  }
  return ["Open Sans Regular", "Noto Sans Regular"];
}

function ensureLineLabelLayer(map, currentTheme) {
  if (!map || typeof map.getLayer !== "function" || typeof map.getSource !== "function" || !map.getStyle()) return;
  const labelId = "go-lines-labels";
  if (map.getLayer?.(labelId)) return;
  if (!map.getSource?.("go-lines")) return;

  const halo = currentTheme === "dark" ? "#0b0b0d" : "#ffffff";
  const lineColor =
    currentTheme === "dark"
      ? ["coalesce", ["get", "colorDark"], ["get", "color"]]
      : ["get", "color"];

  try {
    map.addLayer({
      id: labelId,
      type: "symbol",
      source: "go-lines",
      filter: ["==", ["get", "type"], 2],
      layout: {
        "symbol-placement": "line-center",
        "text-field": ["coalesce", ["get", "shortName"], ["get", "name"], ["get", "routeId"]],
        "text-size": 10,
        "text-font": labelFont(map),
        "text-max-angle": 30,
        "text-rotation-alignment": "map",
        "text-keep-upright": true,
        "text-letter-spacing": 0.2,
        "text-allow-overlap": false,
        "text-ignore-placement": false,
        "symbol-spacing": 180,
        "text-optional": true,
      },
      paint: {
        "text-color": lineColor,
        "text-halo-color": halo,
        "text-halo-width": 2,
      },
    });
  } catch (err) {
    console.warn("Could not add GO line labels", err);
  }
}

function applyMapLayerVisibility(map, mapLayers) {
  if (
    !map ||
    typeof map.getLayer !== "function" ||
    typeof map.setLayoutProperty !== "function" ||
    typeof map.getStyle !== "function" ||
    !map.isStyleLoaded?.() ||
    !map.getStyle()
  ) return;

  const visibility = {
    trainLines: mapLayers?.trainLines ?? true,
    goStations: mapLayers?.goStations ?? true,
    busStops: mapLayers?.busStops ?? true,
    tripRoute: mapLayers?.tripRoute ?? true,
  };

  for (const layerId of ["go-lines-casing", "go-lines-layer", "go-lines-labels"]) {
    if (map.getLayer?.(layerId)) {
      map.setLayoutProperty(layerId, "visibility", visibility.trainLines ? "visible" : "none");
    }
  }

  for (const [layerId, isEnabled] of [
    ["stations-rail-layer", visibility.goStations],
    ["stations-bus-layer", visibility.busStops],
    ["trip-route-layer", visibility.tripRoute],
    ["trip-route-approx-layer", visibility.tripRoute],
    ["trip-stop-layer", visibility.tripRoute],
  ]) {
    if (map.getLayer?.(layerId)) {
      map.setLayoutProperty(layerId, "visibility", isEnabled ? "visible" : "none");
    }
  }
}

function addSourcesAndLayers(map, currentTheme, vehiclesData, tripGeoJson, mapLayers) {
  if (!map || typeof map.getStyle !== "function" || !map.getStyle() || typeof map.isStyleLoaded !== "function" || !map.isStyleLoaded()) return;

  const halo = currentTheme === "dark" ? "#0b0b0d" : "#ffffff";
  const casing = currentTheme === "dark" ? "#f4f4f5" : "#111111";
  const lineColor =
    currentTheme === "dark"
      ? ["coalesce", ["get", "colorDark"], ["get", "color"]]
      : ["get", "color"];

  try {
    if (!map.getSource("go-lines")) {
      map.addSource("go-lines", { type: "geojson", data: linesGeoJson });
    }
    if (!map.getLayer("go-lines-casing")) {
      map.addLayer({
        id: "go-lines-casing",
        type: "line",
        source: "go-lines",
        filter: ["==", ["get", "type"], 2],
        paint: {
          "line-color": casing,
          "line-width": 6,
          "line-opacity": currentTheme === "dark" ? 0.9 : 0.35,
        },
      });
    }
    if (!map.getLayer("go-lines-layer")) {
      map.addLayer({
        id: "go-lines-layer",
        type: "line",
        source: "go-lines",
        filter: ["==", ["get", "type"], 2],
        paint: {
          "line-color": lineColor,
          "line-width": 3.5,
          "line-opacity": 1,
        },
      });
    }

    if (!map.getSource("stations")) {
      map.addSource("stations", { type: "geojson", data: stationsGeoJson });
    }
    if (!map.getLayer("stations-rail-layer")) {
      map.addLayer({
        id: "stations-rail-layer",
        type: "circle",
        source: "stations",
        filter: ["==", ["get", "isRail"], true],
        paint: {
          "circle-radius": 5,
          "circle-color": currentTheme === "dark" ? "#e8e8e8" : "#1a1a1a",
          "circle-stroke-width": 1.5,
          "circle-stroke-color": halo,
        },
      });
    }
    if (!map.getLayer("stations-bus-layer")) {
      map.addLayer({
        id: "stations-bus-layer",
        type: "circle",
        source: "stations",
        filter: ["==", ["get", "isRail"], false],
        paint: {
          "circle-radius": 3.5,
          "circle-color": currentTheme === "dark" ? "#d3d7e0" : "#555555",
          "circle-stroke-width": 1.2,
          "circle-stroke-color": halo,
        },
      });
    }

    if (!map.getSource("vehicles")) {
      map.addSource("vehicles", { type: "geojson", data: vehicleCollection(vehiclesData) });
    } else {
      map.getSource("vehicles").setData(vehicleCollection(vehiclesData));
    }
    if (!map.getLayer("vehicles-layer")) {
      map.addLayer({
        id: "vehicles-layer",
        type: "circle",
        source: "vehicles",
        paint: {
          "circle-radius": 7,
          "circle-color": ["get", "color"],
          "circle-stroke-width": 2,
          "circle-stroke-color": halo,
        },
      });
    }

    if (!map.getSource("trip-route")) {
      map.addSource("trip-route", { type: "geojson", data: tripGeoJson ?? emptyCollection() });
    } else {
      map.getSource("trip-route").setData(tripGeoJson ?? emptyCollection());
    }
    if (!map.getLayer("trip-route-layer")) {
      map.addLayer({
        id: "trip-route-layer",
        type: "line",
        source: "trip-route",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["case", ["get", "selected"], 7, 5],
          "line-opacity": 1,
        },
      });
    }
    if (!map.getLayer("trip-stop-layer")) {
      map.addLayer({
        id: "trip-stop-layer",
        type: "circle",
        source: "trip-route",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": ["case", ["get", "transfer"], 10, 7],
          "circle-color": ["case", ["get", "transfer"], "#ff9f1c", "#0a6efc"],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
          "circle-opacity": 0.95,
        },
      });
    }

    ensureLineLabelLayer(map, currentTheme);
  } catch (err) {
    console.warn("Could not add GO map overlays", err);
  }
}

export default function MapView({
  vehicles,
  selectedVehicleId,
  onSelectVehicle,
  tripGeoJson,
  pickMode,
  onPickPoint,
  theme,
  mapLayers,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const popupRef = useRef(null);
  const appliedThemeRef = useRef(theme);
  const onSelectVehicleRef = useRef(onSelectVehicle);

  const vehiclesDataRef = useRef({ vehicles: [], selectedVehicleId: null });
  const tripGeoJsonRef = useRef(null);
  const themeRef = useRef(theme);
  const mapLayersRef = useRef({
    goStations: true,
    busStops: true,
    trainLines: true,
    tripRoute: true,
  });

  useEffect(() => {
    onSelectVehicleRef.current = onSelectVehicle;
  }, [onSelectVehicle]);

  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  useEffect(() => {
    mapLayersRef.current = {
      goStations: Boolean(mapLayers?.goStations ?? true),
      busStops: Boolean(mapLayers?.busStops ?? true),
      trainLines: Boolean(mapLayers?.trainLines ?? true),
      tripRoute: Boolean(mapLayers?.tripRoute ?? true),
    };

    const map = mapRef.current;
    if (!map) return;
    applyMapLayerVisibility(map, mapLayersRef.current);
  }, [mapLayers]);

  useEffect(() => {
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLES[themeRef.current] ?? MAP_STYLES.light,
      center: GTA_CENTER,
      zoom: 9,
    });
    mapRef.current = map;

    const paintOverlays = () => {
      if (!map || !map.isStyleLoaded()) {
        requestAnimationFrame(paintOverlays);
        return;
      }

      addSourcesAndLayers(
        map,
        themeRef.current,
        vehiclesDataRef.current,
        tripGeoJsonRef.current,
        mapLayersRef.current
      );
      applyMapLayerVisibility(map, mapLayersRef.current);
      ensureLineLabelLayer(map, themeRef.current);
    };

    map.on("style.load", paintOverlays);
    paintOverlays();

    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
    popupRef.current = popup;

    map.on("mousemove", "vehicles-layer", (e) => {
      map.getCanvas().style.cursor = "pointer";
      const feature = e.features[0];
      const p = feature.properties;

      const delayMin = p.arrivalDelay != null ? Math.round(p.arrivalDelay / 60) : null;
      const delayText =
        delayMin == null ? "" : delayMin > 0 ? `${delayMin} min late` : delayMin < 0 ? `${Math.abs(delayMin)} min early` : "On time";

      popup
        .setLngLat(feature.geometry.coordinates)
        .setHTML(
          `<div style="font-family:sans-serif;font-size:13px;line-height:1.4">
              <strong>${p.vehicleLabel}</strong><br/>
              Route: ${p.routeId ?? "—"}<br/>
              ${delayText ? `${delayText}<br/>` : ""}
              Speed: ${p.speed ? Math.round(p.speed) + " km/h" : "—"}
            </div>`
        )
        .addTo(map);
    });

    map.on("mouseleave", "vehicles-layer", () => {
      map.getCanvas().style.cursor = map._pickMode ? "crosshair" : "";
      popup.remove();
    });

    map.on("click", "vehicles-layer", (e) => {
      const id = e.features[0].properties.id;
      onSelectVehicleRef.current?.(id);
    });

    const stationPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
    const stationHoverHandler = (e) => {
      map.getCanvas().style.cursor = "pointer";
      const feature = e.features[0];
      stationPopup
        .setLngLat(feature.geometry.coordinates)
        .setHTML(
          `<div style="font-family:sans-serif;font-size:13px;font-weight:600">${feature.properties.name}</div>`
        )
        .addTo(map);
    };
    const stationLeaveHandler = () => {
      map.getCanvas().style.cursor = map._pickMode ? "crosshair" : "";
      stationPopup.remove();
    };

    map.on("mousemove", "stations-rail-layer", stationHoverHandler);
    map.on("mousemove", "stations-bus-layer", stationHoverHandler);
    map.on("mouseleave", "stations-rail-layer", stationLeaveHandler);
    map.on("mouseleave", "stations-bus-layer", stationLeaveHandler);

    const stationInfoPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: true });
    const stationClickHandler = (e) => {
      const feature = e.features[0];
      const routes = JSON.parse(feature.properties.routesJson || "[]");
      const rail = routes.filter((r) => r.type === 2);
      const bus = routes.filter((r) => r.type !== 2);

      const chip = (r) =>
        `<span style="display:inline-block;margin:2px;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:600;color:#fff;background:${r.color}">${r.shortName}</span>`;

      stationInfoPopup
        .setLngLat(feature.geometry.coordinates)
        .setHTML(
          `<div style="font-family:sans-serif;font-size:13px;max-width:220px">
            <div style="font-weight:700;margin-bottom:6px">${feature.properties.name}</div>
            ${rail.length ? `<div style="margin-bottom:4px"><div style="font-size:11px;color:#666;margin-bottom:2px">RAIL</div>${rail.map(chip).join("")}</div>` : ""}
            ${bus.length ? `<div><div style="font-size:11px;color:#666;margin-bottom:2px">BUS</div>${bus.map(chip).join("")}</div>` : ""}
          </div>`
        )
        .addTo(map);
    };
    map.on("click", "stations-rail-layer", stationClickHandler);
    map.on("click", "stations-bus-layer", stationClickHandler);

    map.on("click", (e) => {
      const mode = map._pickMode;
      if (!mode) return;
      map._onPickPoint?.(mode, { lat: e.lngLat.lat, lon: e.lngLat.lng });
    });

    return () => {
      map.off("style.load", paintOverlays);
      map.remove();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (appliedThemeRef.current === theme) return;

    appliedThemeRef.current = theme;
    themeRef.current = theme;

    const refreshAfterThemeChange = () => {
      addSourcesAndLayers(
        map,
        themeRef.current,
        vehiclesDataRef.current,
        tripGeoJsonRef.current,
        mapLayersRef.current
      );
      applyMapLayerVisibility(map, mapLayersRef.current);
      ensureLineLabelLayer(map, themeRef.current);
    };

    map.once("style.load", refreshAfterThemeChange);
    map.setStyle(MAP_STYLES[theme] ?? MAP_STYLES.light, { diff: false });
  }, [theme]);

  useEffect(() => {
    vehiclesDataRef.current = { vehicles, selectedVehicleId };
    const map = mapRef.current;
    if (!map || !map.getSource("vehicles")) return;
    map.getSource("vehicles").setData(vehicleCollection(vehiclesDataRef.current));
  }, [vehicles, selectedVehicleId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map._pickMode = pickMode;
    map._onPickPoint = onPickPoint;
    map.getCanvas().style.cursor = pickMode ? "crosshair" : "";
  }, [pickMode, onPickPoint]);

  useEffect(() => {
    tripGeoJsonRef.current = tripGeoJson ?? null;
    const map = mapRef.current;
    if (!map || !map.getSource("trip-route")) return;
    map.getSource("trip-route").setData(tripGeoJson ?? emptyCollection());
    const coordinates = (tripGeoJson?.features ?? [])
      .filter((feature) => feature.geometry?.type === "LineString")
      .flatMap((feature) => feature.geometry.coordinates);
    if (coordinates.length > 1) {
      const bounds = coordinates.reduce(
        (result, coordinate) => result.extend(coordinate),
        new maplibregl.LngLatBounds(coordinates[0], coordinates[0])
      );
      map.fitBounds(bounds, { padding: 70, duration: 650, maxZoom: 13 });
    }
  }, [tripGeoJson]);

  return <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />;
}
