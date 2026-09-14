# GO Transit Live Tracker + Trip Planner

MVP scaffold: live vehicle map (backend polls Metrolinx GTFS-RT, frontend renders
markers + hover popups on MapLibre) and a pull-out trip-planner sidebar wired to
proxy to a self-hosted OpenTripPlanner instance.

## What's working right now

- Backend decodes GTFS-RT protobuf and pushes vehicle positions over WebSocket.
- **Runs with mock data out of the box** — no API key needed to see it move.
- Real vector basemap (Carto's free positron/dark-matter styles, no key) showing
  actual GTA streets/geography, with **light/dark toggle** (top-right button) and
  all 7 GO rail lines + UP Express drawn on top (see note below on accuracy).
- Frontend map renders live vehicles, colored by line, with hover info (route,
  delay, speed) and a trip-planner sidebar that slides in/out over the map.
- Origin/destination fields are a **searchable autocomplete** over GO stations
  and major bus terminals — type a few letters, pick from the dropdown. "or
  click a point on the map" underneath still works for anywhere not in that
  list.
- Click "Plan a trip", set origin/destination, pick depart-at or arrive-by,
  choose Any, Rail, or Bus, and hit "Find fastest trip". When OTP is running,
  `/api/plan` returns its full multimodal itineraries. If OTP is unavailable,
  the backend uses the checked-in static GO GTFS schedule and returns exact
  direct train-only or bus-only scheduled trips instead of invented mock routes.

## What you still need to do

### 1. Get a Metrolinx GO API key (for real live data)

1. Go to the GO API Registration page and create an account.
2. Once approved, you'll get an API key and the actual GTFS-RT endpoint URLs
   for your account (VehiclePositions / TripUpdates / ServiceAlerts).
3. Copy `backend/.env.example` to `backend/.env` and fill in `GO_API_KEY` and
   the feed URLs.
4. Also download the GO Transit static GTFS zip from the GO Transit developer
   page — you'll need it for OTP (step 2) and eventually for building a
   stops/routes picker in the UI instead of raw lat/lon clicking.

Until you have the key, the backend automatically serves mock vehicles so you
can keep building the UI. The static GTFS files in `data/gtfs/go` and
`data/gtfs/up` are also used for schedule-based trip planning.

### 2. Stand up OpenTripPlanner for trip planning

OTP needs (a) the GTFS static feed and (b) an OpenStreetMap extract for the
region, and runs as a small Java service:

```bash
mkdir otp && cd otp
# GTFS static feed you downloaded from gotransit.com
cp /path/to/go-transit-gtfs.zip .
# OSM extract for southern Ontario (Geofabrik)
curl -O https://download.geofabrik.de/north-america/canada/ontario-latest.osm.pbf

curl -LO https://repo1.maven.org/maven2/org/opentripplanner/otp/2.5.0/otp-2.5.0-shaded.jar

java -Xmx4G -jar otp-2.5.0-shaded.jar --build --save .
java -Xmx4G -jar otp-2.5.0-shaded.jar --load .
```

That last command serves a REST API at `http://localhost:8080/otp/routers/default`.
Set `OTP_URL` in `backend/.env` to that (it's already the default), restart the
backend, and `/api/plan` will use OTP's full walking and transfer-aware
itineraries. If OTP is stopped, direct schedule results continue to work from
the static GTFS snapshot.

Note: OTP needs real memory (4GB+) and a few minutes to build the graph the
first time. Do this on your dev machine or a small VM, not in a constrained
sandbox.

### 3. Run it

```bash
# terminal 1
cd backend && npm install && npm run dev

# terminal 2
cd frontend && npm install && npm run dev
```

Open http://localhost:5173.

## Known shortcuts taken (intentionally, to get you moving fast)

- **Station/terminal list for the search bar is hand-typed** (`frontend/src/data/stations.js`)
  — covers all GO rail stations plus a handful of major bus terminals, not the
  full stop network. Swap for `stops.txt` from the static GTFS once loaded to
  get hundreds of local stops searchable too.
- **GO rail line paths are hand-approximated**, not real track geometry —
  `frontend/src/data/goLines.js` connects known station lat/lons with straight
  segments. Once you've loaded the static GTFS, swap this for the real
  `shapes.txt` geometry per `route_id` so lines follow the actual corridor.
- **Trip route polyline decoding is stubbed.** OTP returns encoded polylines
  per leg; right now the sidebar just draws a straight line between each leg's
  endpoints so something renders immediately. Swap in `@mapbox/polyline` to
  decode `leg.legGeometry.points` properly once OTP is live — it's a ~10-line
  change in `TripPlannerSidebar.jsx`'s `polylineToGeoJson`.
- **Origin/destination picking is raw lat/lon via map clicks**, not a stop or
  address search. Once you have the static GTFS loaded, a natural next step is
  a stop-name autocomplete (search `stops.txt`) instead of clicking coordinates.
- **Basemap is MapLibre's free demo style** — fine for development, swap for a
  proper vector style (MapTiler, Stadia Maps, etc.) before shipping.
- **Route colors are a rough guess** at GO line colors — replace with the
  official palette from GO's brand guide or `routes.txt`'s `route_color` field.
- **No auth/rate-limiting** on the backend yet — add before deploying publicly,
  since you're the one holding the Metrolinx API key.

## Future improvements

1. Swap raw lat/lon picking for a real stop search (needs GTFS static loaded
   into a small SQLite/Postgres table, or just parsed in memory for an MVP).
2. Decode OTP's real polylines instead of straight lines.
3. Vehicle detail panel: click a vehicle to pin its full trip (all upcoming
   stops + delays), not just the hover popup.
4. Persist/replay: log vehicle positions so you can scrub back in time later.
