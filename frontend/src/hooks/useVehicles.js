import { useEffect, useRef, useState } from "react";

/**
 * Opens a WebSocket to the backend and keeps `vehicles` up to date as new
 * frames arrive. Falls back to REST polling if the socket can't connect.
 */
export function useVehicles() {
  const [vehicles, setVehicles] = useState([]);
  const [connected, setConnected] = useState(false);
  const [live, setLive] = useState(false);
  const socketRef = useRef(null);

  useEffect(() => {
    let pollTimer;

    function connect() {
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${proto}://${window.location.host}/ws/vehicles`);
      socketRef.current = socket;

      socket.onopen = () => setConnected(true);
      socket.onclose = () => {
        setConnected(false);
        // retry after a couple seconds
        setTimeout(connect, 2000);
      };
      socket.onerror = () => socket.close();
      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "vehicles") setVehicles(msg.data);
        } catch {
          // ignore malformed frame
        }
      };
    }

    connect();

    // Also grab /api/vehicles once up front so `live` flag is known
    // even before the first websocket frame lands.
    fetch("/api/vehicles")
      .then((r) => r.json())
      .then((d) => setLive(Boolean(d.live)))
      .catch(() => {});

    return () => {
      socketRef.current?.close();
      clearTimeout(pollTimer);
    };
  }, []);

  return { vehicles, connected, live };
}
