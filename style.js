/* BackHaul AI – deterministic return-load matcher (DEMO MODE, no API needed).
   An LLM (Gemini/OpenAI) is intentionally NOT called. If you add one later, read the key
   from a server-side proxy that loads .env; never ship a key in browser JavaScript. */
'use strict';

// ---------- Data ----------
const CITIES = {
  'Amargol APMC, Hubballi': [15.3905, 75.0586], Hubballi: [15.3647, 75.124], Dharwad: [15.4589, 75.0078],
  Gadag: [15.4166, 75.6297], Belagavi: [15.8497, 74.4977], Haveri: [14.7951, 75.4047],
  Davangere: [14.4644, 75.9218], Chitradurga: [14.2251, 76.398], Tumakuru: [13.3379, 77.1173], Bengaluru: [12.9716, 77.5946],
  Ranebennur: [14.6190, 75.6300], Hosapete: [15.2689, 76.3909], Shivamogga: [13.9299, 75.5681], Hiriyur: [13.9453, 76.6178],
  Mysuru: [12.2958, 76.6394], Vijayapura: [16.8302, 75.7100]
};
const ROAD = 1.25, DIESEL_L_PER_KM = 0.30, DIESEL_PRICE = 92, SPEED = 45, RATE_PER_KM = 28;

let loads = [
  { id: 1, from: 'Hubballi', to: 'Bengaluru', weight: 5, type: 'Electronics', deadline: '21:00', price: 18000 },
  { id: 2, from: 'Dharwad', to: 'Bengaluru', weight: 4, type: 'Textiles', deadline: '20:30', price: 15000 },
  { id: 3, from: 'Gadag', to: 'Bengaluru', weight: 7, type: 'Agricultural produce', deadline: '22:00', price: 20000 },
  { id: 4, from: 'Belagavi', to: 'Bengaluru', weight: 6, type: 'Machinery', deadline: '22:30', price: 24000 },
  { id: 5, from: 'Bengaluru', to: 'Hubballi', weight: 3, type: 'Auto parts', deadline: '20:00', price: 12000 },
  { id: 6, from: 'Davangere', to: 'Bengaluru', weight: 3, type: 'Maize bags', deadline: '23:00', price: 9000 },
  { id: 7, from: 'Ranebennur', to: 'Bengaluru', weight: 5, type: 'Cotton bales', deadline: '21:30', price: 13500 },
  { id: 8, from: 'Haveri', to: 'Tumakuru', weight: 4, type: 'Spices', deadline: '22:00', price: 12500 },
  { id: 9, from: 'Hosapete', to: 'Bengaluru', weight: 6, type: 'Steel coils', deadline: '23:30', price: 21000 },
  { id: 10, from: 'Chitradurga', to: 'Bengaluru', weight: 2, type: 'Groundnut oil', deadline: '23:45', price: 6500 },
  { id: 11, from: 'Shivamogga', to: 'Bengaluru', weight: 5, type: 'Areca nut', deadline: '23:59', price: 17500 },
  { id: 12, from: 'Dharwad', to: 'Bengaluru', weight: 9, type: 'Cement bags', deadline: '21:00', price: 22000 },
  { id: 13, from: 'Hubballi', to: 'Mysuru', weight: 4, type: 'Pharma boxes', deadline: '21:30', price: 16000 },
  { id: 14, from: 'Vijayapura', to: 'Bengaluru', weight: 5, type: 'Grapes (cold chain)', deadline: '19:00', price: 19000 },
  { id: 15, from: 'Gadag', to: 'Hiriyur', weight: 3, type: 'Onions', deadline: '22:30', price: 8800 }
];
let nextId = 16, selectedId = null, lastResults = [], matched = new Set(), map, layer;
const $ = id => document.getElementById(id);
const inr = n => '₹' + Math.round(n).toLocaleString('en-IN');
const key = s => Object.keys(CITIES).find(c => c.toLowerCase() === String(s).trim().toLowerCase());

// ---------- Geometry helpers ----------
function dist(a, b) { // road km between two cities (haversine × road factor)
  const [p, q] = [CITIES[a], CITIES[b]], r = x => x * Math.PI / 180;
  const h = Math.sin(r(q[0] - p[0]) / 2) ** 2 + Math.cos(r(p[0])) * Math.cos(r(q[0])) * Math.sin(r(q[1] - p[1]) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h)) * ROAD;
}
const mins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const hhmm = m => { m = Math.round(m) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };

// Extra km versus driving straight home: truck → pickup → destination.
function calculateDetour(t, l) { return Math.max(0, dist(t.from, l.from) + dist(l.from, t.to) - dist(t.from, t.to)); }

// Diesel saved: loaded km that were going to be empty, minus detour km driven. 0.30 L/km.
function calculateFuelSaving(t, l) { return Math.max(0, (dist(l.from, l.to) - calculateDetour(t, l)) * DIESEL_L_PER_KM); }

// Transparent benchmark price for the load (scaled by how full the truck gets).
function fairRate(t, l) { return dist(l.from, l.to) * RATE_PER_KM * (0.7 + 0.3 * l.weight / t.cap); }

// ---------- Matching algorithm (25 capacity + 25 route + 20 detour + 15 deadline + 15 revenue = 100) ----------
function calculateMatchScore(t, l) {
  const detour = calculateDetour(t, l), arrive = mins(t.time) + dist(t.from, l.from) / SPEED * 60;
  const slack = (mins(l.deadline) - arrive) / 60; // hours to spare at pickup
  // Hard filters: load must fit, be reachable before deadline, and finish near the truck's destination.
  if (l.weight > t.avail) return { ok: false, reason: 'Too heavy' };
  if (slack < 0) return { ok: false, reason: 'Misses deadline' };
  const dropGap = dist(l.to, t.to);
  if (dropGap > 120) return { ok: false, reason: 'Wrong direction' };
  const clamp = x => Math.max(0, Math.min(1, x));
  const cap = 25 * (0.4 + 0.6 * clamp(l.weight / t.avail));        // fuller truck = better
  const route = 25 * clamp(1 - dropGap / 120) * clamp(1 - detour / 160 * 0.5); // drop near destination, pickup on the way
  const det = 20 * clamp(1 - detour / 90);                          // small detour
  const dl = 15 * clamp(slack / 4);                                 // comfortable pickup window
  const rpk = l.price / dist(l.from, l.to);
  const rev = 15 * clamp((rpk - 18) / 30);                          // ₹/km vs ₹18–48 range
  const parts = [cap, route, det, dl, rev];
  return { ok: true, score: Math.round(parts.reduce((a, b) => a + b, 0)), parts, detour, slack, arrive };
}

function rankLoads(t, list) {
  return list.map(l => ({ l, r: calculateMatchScore(t, l) })).filter(x => x.r.ok).sort((a, b) => b.r.score - a.r.score);
}

// ---------- Input ----------
function readTruck() {
  const t = { from: key($('tFrom').value), to: key($('tTo').value), cap: +$('tCap').value, avail: +$('tAvail').value, type: $('tType').value, time: $('tTime').value };
  let e = '';
  if (!t.from || !t.to) e = 'Pick locations from the list: ' + Object.keys(CITIES).join(', ') + '.';
  else if (t.from === t.to) e = 'Location and destination must differ.';
  else if (!(t.cap > 0) || !(t.avail > 0)) e = 'Capacity values must be positive.';
  else if (t.avail > t.cap) e = 'Available capacity cannot exceed truck capacity.';
  else if (!t.time) e = 'Enter the time the truck can leave.';
  $('errT').textContent = e; return e ? null : t;
}

function postLoad() {
  const l = { id: nextId, from: key($('cPick').value), to: key($('cDrop').value), weight: +$('cWeight').value, type: $('cType').value.trim(), deadline: $('cDeadline').value, price: +$('cPrice').value };
  let e = '';
  if (!l.from || !l.to) e = 'Pick locations from the list: ' + Object.keys(CITIES).join(', ') + '.';
  else if (l.from === l.to) e = 'Pickup and delivery must differ.';
  else if (!(l.weight > 0)) e = 'Enter a cargo weight above 0.';
  else if (!l.type) e = 'Enter the cargo type.';
  else if (!l.deadline) e = 'Set a pickup deadline.';
  else if (!(l.price > 0)) e = 'Enter the offered price.';
  $('errC').textContent = e; if (e) return;
  loads.push(l); nextId++;
  ['cPick', 'cWeight', 'cType', 'cPrice'].forEach(i => $(i).value = '');
  renderLoads(); switchTab('find'); $('errT').textContent = ''; findMatches();
}

// ---------- Rendering ----------
function statusBadge(l, t) {
  if (matched.has(l.id)) return '<span class="badge b-matched">Matched</span>';
  if (!t) return '<span class="badge b-warn">Open</span>';
  const r = calculateMatchScore(t, l);
  return r.ok ? '<span class="badge b-ok">Eligible</span>' : `<span class="badge b-bad">${r.reason}</span>`;
}
function renderLoads() {
  const t = readTruckQuiet();
  $('loadCount').textContent = `(${loads.length})`;
  $('loadRows').innerHTML = loads.map(l => {
    const f = t ? fairRate(t, l) : l.weight * dist(l.from, l.to) * 4, d = (l.price - f) / f * 100;
    return `<tr><td>${l.from} → ${l.to}</td><td>${l.type}</td><td>${l.weight} t</td><td>${inr(l.price)}</td>
    <td>${inr(f)} <span class="badge ${d < -8 ? 'b-bad' : 'b-ok'}">${d >= 0 ? '+' : ''}${Math.round(d)}%</span></td><td>${statusBadge(l, t)}</td></tr>`;
  }).join('');
}
function readTruckQuiet() {
  const t = { from: key($('tFrom').value), to: key($('tTo').value), cap: +$('tCap').value, avail: +$('tAvail').value, time: $('tTime').value };
  return t.from && t.to && t.cap > 0 && t.avail > 0 && t.avail <= t.cap && t.time ? t : null;
}

function recommendation(r, i) {
  if (r.score >= 80) return 'Strong match. Accept now, this saves most of the return trip.';
  if (r.score >= 60) return 'Good option. Small detour, healthy pay.';
  return 'Fallback. Consider only if nothing better arrives.';
}

function renderMatches(t, ranked) {
  const box = $('results');
  if (!ranked.length) { box.innerHTML = '<div class="empty"><b>No suitable return loads.</b><br>Try raising available capacity, leaving later, or posting a load from the Post Load tab.</div>'; return; }
  box.innerHTML = ranked.slice(0, 3).map(({ l, r }, i) => {
    const fuel = calculateFuelSaving(t, l), f = fairRate(t, l), d = (l.price - f) / f * 100, done = matched.has(l.id);
    return `<article class="card ${i === 0 ? 'best' : ''} ${selectedId === l.id ? 'sel' : ''}" data-id="${l.id}">
      <div class="card-top"><div class="score">${r.score}<small>/100</small></div>
        <span class="badge ${done ? 'b-matched' : i === 0 ? 'b-ok' : 'b-warn'}">${done ? 'Matched' : i === 0 ? 'Best match' : 'Option ' + (i + 1)}</span></div>
      <div class="parts" title="Capacity, route, detour, deadline, revenue">${r.parts.map(p => `<i style="flex:${Math.max(p, .5)}"></i>`).join('')}</div>
      <div class="route">${l.from} → ${l.to}</div>
      <div class="stats">
        <div><span>Cargo</span><b>${l.type}</b></div><div><span>Weight</span><b>${l.weight} t of ${t.avail} t free</b></div>
        <div><span>Detour</span><b>${Math.round(r.detour)} km</b></div><div><span>Revenue</span><b>${inr(l.price)} (${d >= 0 ? '+' : ''}${Math.round(d)}% vs fair)</b></div>
        <div><span>Fuel saving</span><b>${Math.round(fuel)} L</b></div><div><span>Reach pickup</span><b>${hhmm(r.arrive)} (by ${l.deadline})</b></div>
      </div>
      <div class="rec">${recommendation(r, i)}</div>
      <div class="actions"><button class="btn" data-voice="${l.id}">Voice brief</button>
        <button class="btn primary" data-accept="${l.id}" ${done ? 'disabled' : ''}>${done ? 'Matched' : 'Accept Load'}</button></div>
    </article>`;
  }).join('');
}

function updateDashboard(t, l) {
  if (!l) { ['kKm', 'kFuel'].forEach(i => $(i).textContent = '0'); $('kRev').textContent = '₹0'; $('kUtil').textContent = '0%'; $('kUtilBar').style.width = '0'; $('kNote').textContent = 'Select a match'; $('impactBox').innerHTML = ''; return; }
  const km = dist(l.from, l.to), det = calculateDetour(t, l), util = Math.round((t.cap - t.avail + l.weight) / t.cap * 100);
  $('kKm').textContent = Math.round(km); $('kFuel').textContent = Math.round(calculateFuelSaving(t, l));
  $('kRev').textContent = inr(l.price); $('kUtil').textContent = util + '%'; $('kUtilBar').style.width = util + '%';
  $('kNote').textContent = matched.has(l.id) ? 'Confirmed' : 'Projected for selection';
  const f = fairRate(t, l), net = Math.round((km - det) * DIESEL_L_PER_KM * DIESEL_PRICE);
  $('impactBox').innerHTML = `<div class="cmp"><div><span>Truck load before</span><b>${Math.round((t.cap - t.avail) / t.cap * 100)}%</b></div><div class="bar"><i style="width:${Math.round((t.cap - t.avail) / t.cap * 100)}%"></i></div></div>
    <div class="cmp"><div><span>Truck load after</span><b>${util}%</b></div><div class="bar"><i style="width:${util}%"></i></div></div>
    <div class="cmp"><div><span>Offer vs fair market rate</span><b>${inr(l.price)} vs ${inr(f)}</b></div><div class="bar"><i style="width:${Math.min(100, l.price / f * 50)}%"></i></div></div>
    <p><b>Diesel worth ${inr(net)}</b> is put to work instead of burned on an empty return.</p>`;
}

function drawMap(t, l) {
  if (!window.L) { $('map').innerHTML = '<div class="empty">Map needs internet (Leaflet CDN).</div>'; return; }
  if (!map) { map = L.map('map').setView([14.2, 76.3], 6); L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map); layer = L.layerGroup().addTo(map); }
  layer.clearLayers();
  const pt = c => CITIES[c], pts = [pt(t.from), pt(t.to)];
  L.polyline(pts, { color: '#9aa9ba', weight: 3, dashArray: '6 8' }).addTo(layer);
  L.circleMarker(pt(t.from), { radius: 8, color: '#0b2a4a', fillColor: '#0b2a4a', fillOpacity: 1 }).bindTooltip('Truck: ' + t.from).addTo(layer);
  L.circleMarker(pt(t.to), { radius: 8, color: '#12805c', fillColor: '#12805c', fillOpacity: 1 }).bindTooltip('Home: ' + t.to).addTo(layer);
  if (l) {
    pts.push(pt(l.from));
    L.polyline([pt(t.from), pt(l.from), pt(l.to)], { color: '#f2a900', weight: 5 }).addTo(layer);
    L.circleMarker(pt(l.from), { radius: 8, color: '#f2a900', fillColor: '#fff', fillOpacity: 1 }).bindTooltip('Pickup: ' + l.from).addTo(layer);
  }
  map.fitBounds(pts, { padding: [30, 30] }); setTimeout(() => map.invalidateSize(), 50);
}

// ---------- Actions ----------
function select(id) {
  selectedId = id; const t = readTruckQuiet(), l = loads.find(x => x.id === id);
  document.querySelectorAll('.card').forEach(c => c.classList.toggle('sel', +c.dataset.id === id));
  if (t && l) { updateDashboard(t, l); drawMap(t, l); }
}
function findMatches() {
  const t = readTruck(); if (!t) return;
  const btn = $('findBtn'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Matching loads…';
  setTimeout(() => {
    lastResults = rankLoads(t, loads.filter(l => !matched.has(l.id)).concat(loads.filter(l => matched.has(l.id))));
    selectedId = lastResults.length ? lastResults[0].l.id : null;
    renderMatches(t, lastResults); renderLoads();
    updateDashboard(t, selectedId ? loads.find(l => l.id === selectedId) : null); drawMap(t, selectedId ? loads.find(l => l.id === selectedId) : null);
    btn.disabled = false; btn.textContent = 'Find Best Return Loads';
  }, 700);
}
function voiceBrief(id) { // Operators work on calls: read the offer aloud in plain words.
  const t = readTruckQuiet(), l = loads.find(x => x.id === id); if (!t || !l) return;
  const msg = `Load from ${l.from} to ${l.to}. ${l.weight} tons of ${l.type}. Offered price ${Math.round(l.price)} rupees. Fair rate is about ${Math.round(fairRate(t, l))} rupees. Pickup before ${l.deadline}. Detour ${Math.round(calculateDetour(t, l))} kilometres.`;
  if ('speechSynthesis' in window) { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(msg); u.lang = 'en-IN'; speechSynthesis.speak(u); } else alert(msg);
}
function switchTab(n) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === n));
  $('tab-find').hidden = n !== 'find'; $('tab-post').hidden = n !== 'post';
}

// ---------- Init ----------
$('cities').innerHTML = Object.keys(CITIES).map(c => `<option value="${c}">`).join('');
['tTo', 'cDrop'].forEach(i => { // destination dropdowns
  $(i).innerHTML = Object.keys(CITIES).map(c => `<option value="${c}">${c}</option>`).join('');
  $(i).value = 'Bengaluru';
});
document.querySelectorAll('.tab').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
$('findBtn').onclick = findMatches; $('postBtn').onclick = postLoad;
$('results').onclick = e => {
  const a = e.target.closest('[data-accept]'), v = e.target.closest('[data-voice]'), c = e.target.closest('.card');
  if (a) { matched.add(+a.dataset.accept); const t = readTruckQuiet(); renderMatches(t, lastResults); renderLoads(); select(+a.dataset.accept); }
  else if (v) voiceBrief(+v.dataset.voice);
  else if (c) select(+c.dataset.id);
};
['tFrom', 'tTo', 'tCap', 'tAvail', 'tTime'].forEach(i => $(i).addEventListener('change', renderLoads));
renderLoads(); findMatches(); // demo data auto-runs on first load
