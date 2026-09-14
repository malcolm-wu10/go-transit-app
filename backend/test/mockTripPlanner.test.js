import test from "node:test";
import assert from "node:assert/strict";
import { mockTripPlan } from "../services/mockTripPlanner.js";

test("mock trip planner returns itineraries when OTP is unavailable", () => {
  const plan = mockTripPlan({
    fromLat: 43.6452,
    fromLon: -79.3806,
    toLat: 43.774,
    toLon: -79.466,
    mode: "TRANSIT,WALK",
  });

  assert.ok(plan && plan.plan && Array.isArray(plan.plan.itineraries));
  assert.ok(plan.plan.itineraries.length >= 1);
  assert.ok(plan.plan.itineraries[0].legs.length >= 1);
  assert.ok(["RAIL", "BUS"].includes(plan.plan.itineraries[0].legs[0].mode));
  assert.ok(plan.plan.itineraries[0].duration > 0);
});

test("station-based trips omit fake walk legs and keep vehicle instructions clear", () => {
  const plan = mockTripPlan({
    fromLat: 43.645195,
    fromLon: -79.3806,
    toLat: 43.266775,
    toLon: -79.866222,
    mode: "TRANSIT,WALK",
  });

  const first = plan.plan.itineraries[0];
  assert.equal(first.legs[0].mode, "RAIL");
  assert.ok(["LW", "LE", "MI", "KI", "ST"].includes(first.legs[0].route));
  assert.ok(first.legs[0].from.name.includes("Station") || first.legs[0].from.name.includes("GO"));
  assert.ok(first.legs[first.legs.length - 1].to.name.includes("GO") || first.legs[first.legs.length - 1].to.name.includes("Station"));
  assert.equal(first.legs.filter((leg) => leg.mode === "WALK").length, 0);
});

test("GO corridor durations stay in realistic ranges for long rail trips", () => {
  const hamilton = mockTripPlan({
    fromLat: 43.645195,
    fromLon: -79.3806,
    toLat: 43.266775,
    toLon: -79.866222,
    mode: "RAIL",
  });

  const kitchener = mockTripPlan({
    fromLat: 43.645195,
    fromLon: -79.3806,
    toLat: 43.4523,
    toLon: -80.4995,
    mode: "RAIL",
  });

  const stouffville = mockTripPlan({
    fromLat: 43.645195,
    fromLon: -79.3806,
    toLat: 43.9709,
    toLon: -79.24999,
    mode: "RAIL",
  });

  assert.ok(hamilton.plan.itineraries[0].duration >= 70 * 60);
  assert.ok(kitchener.plan.itineraries[0].duration >= 90 * 60);
  assert.ok(stouffville.plan.itineraries[0].duration >= 45 * 60);
});
