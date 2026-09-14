import { useState } from "react";
import MapView from "./components/MapView.jsx";
import TripPlannerSidebar from "./components/TripPlannerSidebar.jsx";
import { useVehicles } from "./hooks/useVehicles.js";

export default function App() {
  const { vehicles, connected, live } = useVehicles();

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [selectedVehicleId, setSelectedVehicleId] = useState(null);
  const [pickMode, setPickMode] = useState(null); // "origin" | "destination" | null
  const [origin, setOrigin] = useState(null);
  const [destination, setDestination] = useState(null);
  const [tripGeoJson, setTripGeoJson] = useState(null);
  const [mapLayers, setMapLayers] = useState({
    goStations: true,
    busStops: true,
    trainLines: true,
    tripRoute: true,
  });

  function handlePickPoint(mode, point) {
    if (mode === "origin") setOrigin(point);
    if (mode === "destination") setDestination(point);
    setPickMode(null);
  }

  const [theme, setTheme] = useState("light"); // "light" | "dark"

  return (
    <div className={`app-root theme-${theme}`} style={{ position: "relative", width: "100vw", height: "100vh" }}>
      <MapView
        vehicles={vehicles}
        selectedVehicleId={selectedVehicleId}
        onSelectVehicle={setSelectedVehicleId}
        tripGeoJson={tripGeoJson}
        pickMode={pickMode}
        onPickPoint={handlePickPoint}
        theme={theme}
        mapLayers={mapLayers}
      />

      <div className="status-badge">
        {connected ? (live ? "● Live" : "● Mock data") : "○ Connecting…"}
        {pickMode && <span className="pick-hint"> — click the map to set {pickMode}</span>}
      </div>

      <button
        className="theme-toggle"
        onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
        aria-label="Toggle light/dark map"
      >
        {theme === "light" ? "🌙 Dark" : "☀️ Light"}
      </button>

      <TripPlannerSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen((o) => !o)}
        origin={origin}
        destination={destination}
        onSetOrigin={setOrigin}
        onSetDestination={setDestination}
        onStartPicking={(mode) => setPickMode(mode)}
        onPlanReady={setTripGeoJson}
        mapLayers={mapLayers}
        onToggleMapLayer={(key) =>
          setMapLayers((current) => ({
            ...current,
            [key]: !current[key],
          }))
        }
      />
    </div>
  );
}
