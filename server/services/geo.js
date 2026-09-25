// Geographic helpers — haversine distance & route heuristics
const R = 6371; // km

function haversine(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Total length of a route visiting points in order
function routeLength(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++)
    d += haversine(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
  return d;
}

// Cheapest-insertion cost of adding `p` into an existing route
function insertionCost(route, p) {
  if (route.length === 0) return 0;
  if (route.length === 1) return haversine(route[0].lat, route[0].lng, p.lat, p.lng);
  let best = Infinity;
  for (let i = 0; i <= route.length; i++) {
    const prev = route[i - 1], next = route[i];
    let cost;
    if (!prev) cost = haversine(p.lat, p.lng, next.lat, next.lng);
    else if (!next) cost = haversine(prev.lat, prev.lng, p.lat, p.lng);
    else cost = haversine(prev.lat, prev.lng, p.lat, p.lng) +
                haversine(p.lat, p.lng, next.lat, next.lng) -
                haversine(prev.lat, prev.lng, next.lat, next.lng);
    best = Math.min(best, cost);
  }
  return best;
}

// Nearest-neighbour ordering (route pre-sort for drivers)
function orderRoute(points, start) {
  const remaining = [...points];
  const ordered = [];
  let cur = start || remaining[0];
  while (remaining.length) {
    let bi = 0, bd = Infinity;
    remaining.forEach((p, i) => {
      const d = haversine(cur.lat, cur.lng, p.lat, p.lng);
      if (d < bd) { bd = d; bi = i; }
    });
    cur = remaining.splice(bi, 1)[0];
    ordered.push(cur);
  }
  return ordered;
}

module.exports = { haversine, routeLength, insertionCost, orderRoute };
