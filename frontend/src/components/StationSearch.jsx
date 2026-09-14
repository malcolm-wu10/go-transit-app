import { useEffect, useMemo, useState } from "react";
import stopsData from "../data/generated/stops.json";

const stations = stopsData.map((s) => ({
  name: s.name,
  lat: s.lat,
  lon: s.lon,
  type: s.routes.some((r) => r.type === 2) ? "rail" : "bus",
}));

export default function StationSearch({ placeholder, value, onSelect, onPickOnMap }) {
  const [query, setQuery] = useState(value?.name || "");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!value) {
      setQuery("");
    } else if (value.name) {
      setQuery(value.name);
    } else {
      setQuery(`Custom location (${value.lat.toFixed(4)}, ${value.lon.toFixed(4)})`);
    }
  }, [value]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return stations.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 8);
  }, [query]);

  function handleSelect(station) {
    setQuery(station.name);
    setOpen(false);
    onSelect({ name: station.name, lat: station.lat, lon: station.lon });
  }

  return (
    <div className="station-search">
      <input
        type="text"
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />

      {open && results.length > 0 && (
        <ul className="station-results">
          {results.map((s, i) => (
            <li key={`${s.name}-${i}`} onMouseDown={() => handleSelect(s)}>
              <span className={`station-tag ${s.type}`}>{s.type === "rail" ? "RAIL" : "BUS"}</span>
              {s.name}
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className="pick-on-map-link"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setOpen(false);
          onPickOnMap();
        }}
      >
        or click a point on the map
      </button>
    </div>
  );
}
