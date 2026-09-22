/* Tours Route Recorder — capture a real GPS walk, mark POIs/checkpoints,
 * and POST the route to the aisee-tours-backend Apps Script API.
 *
 * No build step, no pasted config. The backend is a LOGIN PROXY: "Sign in with
 * Google" navigates the tab to the backend (Google-gated), which redirects back
 * with an HMAC session token in the URL fragment. We store that token and send
 * it on writes; the backend verifies it. The Maps key + projects come from the
 * backend's `bootstrap` after login.
 *
 * Geolocation needs a secure context: https:// or http://localhost. */

'use strict';

// The one platform backend (pinned /exec). Override only via advanced settings.
var BACKEND_URL  = 'https://script.google.com/macros/s/AKfycbyjH-U0ysuHbifKyMnbvimng4XrDALgsG89s-CU11nqdcKzPXnmw9WyD4zZOewnENHvbA/exec';
var SESSION_KEY  = 'aiseeRecorder.session';   // { email, name, token }
var NONCE_KEY    = 'aiseeRecorder.nonce';
var PROJECT_KEY  = 'aiseeRecorder.projectId';
var OVERRIDE_KEY = 'aiseeRecorder.backendOverride';
var DRAFT_KEY    = 'aiseeRecorder.draft';     // in-progress route, autosaved so a lock/reload can't lose it
var ERRLOG_KEY   = 'aiseeRecorder.errlog';    // rolling ring of recent errors, viewable from the profile menu

var $ = function (id) { return document.getElementById(id); };

function backendUrl() { try { return localStorage.getItem(OVERRIDE_KEY) || BACKEND_URL; } catch (e) { return BACKEND_URL; } }
function returnUrl()  { return location.href.split('#')[0].split('?')[0]; }
function loadSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch (e) { return null; } }
function saveSession(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {} }
function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch (e) {} AUTH = null; }

function uuid() {
  try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/* ── Error log ───────────────────────────────────────────────
 * iOS Safari collapses a failed `Response.json()` into the opaque "The string
 * did not match the expected pattern." With no console on a phone, errors were
 * invisible. We keep the last ~40 here (with HTTP status + a body snippet where
 * we can get one) so any failure is reportable from the profile menu. */
function logError(context, err, extra) {
  try {
    var log = getErrorLog();
    log.push({
      t: new Date().toISOString(),
      ctx: context,
      msg: (err && err.message) ? err.message : String(err),
      extra: extra || null,
      ua: navigator.userAgent
    });
    while (log.length > 40) log.shift();
    localStorage.setItem(ERRLOG_KEY, JSON.stringify(log));
  } catch (e) {}
}
function getErrorLog() { try { return JSON.parse(localStorage.getItem(ERRLOG_KEY)) || []; } catch (e) { return []; } }
function clearErrorLog() { try { localStorage.removeItem(ERRLOG_KEY); } catch (e) {} }

/* POST JSON to the backend and return the parsed reply. Reads the body as TEXT
 * first, then parses — so when the Apps Script 302-follow hands back an HTML
 * error/login page (or the fetch is cut short by iOS backgrounding the tab), we
 * raise a legible "HTTP <status>: <snippet>" instead of the WebKit pattern error,
 * and record it. `context` labels the call in the error log. */
function postJson(payload, context) {
  return fetch(backendUrl(), { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) })
    .then(function (r) { return r.text().then(function (text) { return { status: r.status, ok: r.ok, text: text }; }); })
    .then(function (resp) {
      var data;
      try { data = JSON.parse(resp.text); }
      catch (e) {
        var snippet = (resp.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        var msg = 'HTTP ' + resp.status + ' — backend did not return JSON' + (snippet ? ': ' + snippet : ' (empty response)');
        var err = new Error(msg);
        logError(context || 'postJson', err, { status: resp.status, action: payload && payload.action });
        throw err;
      }
      if (!data || !data.ok) {
        var rejErr = new Error((data && data.error) || 'backend rejected the request');
        logError(context || 'postJson', rejErr, { status: resp.status, action: payload && payload.action });
        throw rejErr;
      }
      return data;
    }, function (netErr) {
      logError(context || 'postJson', netErr, { network: true, action: payload && payload.action });
      throw netErr;
    });
}

/* ── State ───────────────────────────────────────────────── */
var AUTH = null;          // { email, name, token }
var mapsKey = '';
var map, meMarker, accCircle, trackPoly;
var trackPath = [];      // [{lat,lng}] raw GPS samples while recording
var marks = [];          // [{kind, lat, lng, accuracy_m, marker, name?, category?, briefing_md?, geofence_radius_m?}]
var recording = false, started = false, follow = true, lastFix = null, watchId = null, pendingPoi = null;

/* ── Editing an existing tour ─────────────────────────────── */
var editingRouteId = null;     // route_id when extending a loaded tour, else null
var tourName = '';             // name given to a NEW tour before recording (required to start)
var loadedRoute = null;        // the loaded Routes row (name/desc/status/… for the save sheet)
var loadedVersion = null;      // content_version we loaded (optimistic concurrency)
var existingPath = [];         // [{lat,lng}] decoded base track_polyline (frozen)
var existingPoly = null;       // grey polyline drawn for the existing track
var tourBox = null;            // google.maps.LatLngBounds covering the loaded tour
var farOutside = false;        // true when the current fix is well outside that box
var linkTempPolys = [];        // temporary alternative-path polylines in the resolver

var NEAR_ATTACH_M = 40;        // a new segment endpoint within this of the base counts as "joined to it"
var LINK_GAP_M    = 12;        // joins wider than this open the conflict resolver; below, join straight
var AREA_MARGIN_M = 150;       // min buffer around the tour box before "too far" trips

/* ── Draft autosave ──────────────────────────────────────────
 * Everything the recorder holds in memory (marks, GPS track, editing context)
 * is mirrored to localStorage after each mark and periodically while recording,
 * so a phone lock that evicts the backgrounded tab — the "10+ POIs, came back to
 * a blank page" report — can be recovered on the next load. */
var saveOpId = null;           // stable idempotency key for the current route's save; survives retries + reloads
var lastDraftAt = 0;           // throttle stamp for autosave during a walk

function markData(m) {
  return { kind: m.kind, existing: !!m.existing, poi_id: m.poi_id || null,
    lat: m.lat, lng: m.lng, accuracy_m: m.accuracy_m,
    name: m.name || '', category: m.category || '', briefing_md: m.briefing_md || '',
    poi_type: m.poi_type || 'primary', geofence_radius_m: m.geofence_radius_m };
}
/* True unsaved work worth recovering — a walked track, or any NEW (non-loaded) mark. */
function hasUnsavedWork() {
  return trackPath.length > 0 || marks.some(function (m) { return !m.existing; });
}
function saveDraft(force) {
  if (!hasUnsavedWork()) { clearDraft(); return; }
  var now = Date.now();
  if (!force && now - lastDraftAt < 4000) return;   // during a walk onPos fires ~1/s; don't thrash storage
  lastDraftAt = now;
  var lr = loadedRoute ? { route_id: loadedRoute.route_id, name: loadedRoute.name, description: loadedRoute.description,
    status: loadedRoute.status, tracking_mode: loadedRoute.tracking_mode, content_version: loadedRoute.content_version } : null;
  var draft = { v: 1, savedAt: now, projectId: $('projSel').value, tourName: tourName,
    editingRouteId: editingRouteId, loadedVersion: loadedVersion, loadedRoute: lr,
    existingPath: existingPath, trackPath: trackPath, started: started, saveOpId: saveOpId,
    marks: marks.map(markData) };
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch (e) { logError('saveDraft', e); }
}
function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) {} }
function loadDraft() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)) || null; } catch (e) { return null; } }

/* ── Boot ────────────────────────────────────────────────── */
window.addEventListener('load', function () {
  // Mobile-only: the recorder needs a phone's GPS. Desktops (except localhost
  // dev) get a friendly "open on your phone" screen with a QR to this URL.
  if (!isMobileDevice() && !isLocalDev()) { showDesktopBlock(); return; }
  wireUi();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  handleAuthCallback();          // catch #token=… coming back from the broker
  AUTH = loadSession();
  if (AUTH && AUTH.token) startAuthed();
  else showSignIn();
});

/* ── Device gate (mobile-only) ───────────────────────────── */
function isLocalDev() {
  var h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '';
}
function isMobileDevice() {
  // Prefer the explicit hint when the browser provides it (Chromium).
  try { if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') return navigator.userAgentData.mobile; } catch (e) {}
  var ua = navigator.userAgent || navigator.vendor || '';
  if (/Android|iPhone|iPod|Windows Phone|webOS|BlackBerry|Opera Mini|IEMobile|Mobile/i.test(ua)) return true;
  // iPadOS 13+ reports as desktop Safari — detect the touch screen instead.
  if (/iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
  return false;
}
function showDesktopBlock() {
  var url = location.origin + location.pathname;
  var a = $('dbUrl'); a.textContent = url; a.href = url;
  $('dbQr').src = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=0&data=' + encodeURIComponent(url);
  show('desktopBlock');
}

/* ── Login broker flow (AHL pattern; no Google Identity Services) ───── */
function showSignIn(msg) { $('signinMsg').textContent = msg || ''; show('signinSheet'); }

function startAuthed() {
  hide('signinSheet');
  setProfile(AUTH.name || AUTH.email || '', AUTH.email || '');
  bootstrap();
}

/* Fill the profile balloon's name + email. */
function setProfile(name, email) {
  $('popName').textContent = name || '(not signed in)';
  $('popEmail').textContent = email || '';
}

function signIn() {
  var nonce = randomNonce();
  try { localStorage.setItem(NONCE_KEY, nonce); }
  catch (e) { alert('Your browser blocked site storage; sign-in needs it (try a non-private window).'); return; }
  var loginUrl = backendUrl() + '?action=login&return=' + encodeURIComponent(returnUrl()) + '&nonce=' + encodeURIComponent(nonce);
  // Route through Google's account chooser so users on a multi-account device pick
  // their Aisee/AHLab account instead of the browser's default (Apps Script web
  // apps otherwise silently reuse the active /u/N/ account with no picker).
  location.assign('https://accounts.google.com/AccountChooser?continue=' + encodeURIComponent(loginUrl));
}

function handleAuthCallback() {
  if (!location.hash || location.hash.indexOf('token=') === -1) return;
  var p = parseHash(location.hash);
  var expected = ''; try { expected = localStorage.getItem(NONCE_KEY) || ''; } catch (e) {}
  if (p.token && p.nonce && expected && p.nonce === expected) {
    try { localStorage.removeItem(NONCE_KEY); } catch (e) {}
    saveSession({ email: p.email || '', name: p.name || '', token: p.token });
  }
  history.replaceState(null, '', location.pathname + location.search); // strip the fragment
}

function parseHash(h) {
  var out = {};
  h.replace(/^#/, '').split('&').forEach(function (kv) {
    var i = kv.indexOf('='); if (i === -1) return;
    out[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
  });
  return out;
}

function randomNonce() {
  try { var b = new Uint8Array(16); crypto.getRandomValues(b); return Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }
  catch (e) { return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }
}

/* Post-login: fetch identity + Maps key + projects, then start the map. */
function bootstrap() {
  fetch(backendUrl() + '?action=bootstrap&auth=' + encodeURIComponent(AUTH.token))
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (!res || !res.ok) { clearSession(); showSignIn((res && res.error) || 'Session expired — please sign in again.'); return; }
      setProfile((res.user && (res.user.name || res.user.email)) || AUTH.name || AUTH.email,
                 (res.user && res.user.email) || AUTH.email || '');
      fillProjects(res.projects || [], res.defaultProjectId || '');
      mapsKey = res.mapsKey || '';
      if (!mapsKey) { showMapMsg('No Maps key set on the backend — add the MAPS_API_KEY Script Property.'); return; }
      showLocating();
      startGeo();   // GPS warms up while the Maps script loads
      ensureMaps(mapsKey, function (ok) {
        if (!ok) { showMapMsg('Google Maps failed to load — check the key, enabled APIs, and billing.'); return; }
        initMap(); maybeOfferRestore();
      });
    })
    .catch(function (e) { showMapMsg('Could not reach the backend: ' + e.message); });
}

var projectsData = [];   // [{project_id, name, description}] — backs the picker

function fillProjects(projects, defaultProjectId) {
  projectsData = projects || [];
  var sel = $('projSel');
  while (sel.options.length > 1) sel.remove(1);
  projectsData.forEach(function (p) { var o = document.createElement('option'); o.value = p.project_id; o.textContent = p.name; sel.appendChild(o); });
  var saved = ''; try { saved = localStorage.getItem(PROJECT_KEY) || ''; } catch (e) {}
  sel.value = saved || defaultProjectId || ((projectsData[0] || {}).project_id) || '';
  syncProjLabel();
}

function projName(pid) {
  for (var i = 0; i < projectsData.length; i++) if (projectsData[i].project_id === pid) return projectsData[i].name;
  return '';
}
function syncProjLabel() {
  var pid = $('projSel').value;
  $('projBtnLabel').textContent = pid ? (projName(pid) || pid) : '— project —';
}

/* Full-screen project picker (replaces the native <select> dropdown). */
function openProjectPicker() {
  if (!projectsData.length) return toast('No projects available');
  renderProjectCards();
  show('projScreen');
}
function renderProjectCards() {
  var list = $('projList'); list.innerHTML = '';
  var cur = $('projSel').value;
  projectsData.forEach(function (p) {
    var card = document.createElement('button');
    card.className = 'proj-card' + (p.project_id === cur ? ' sel' : '');
    var name = document.createElement('span'); name.className = 'pc-name'; name.textContent = p.name || p.project_id;
    card.appendChild(name);
    if (p.description) { var d = document.createElement('span'); d.className = 'pc-desc'; d.textContent = p.description; card.appendChild(d); }
    var count = document.createElement('span'); count.className = 'pc-count'; count.textContent = '… tours'; card.appendChild(count);
    if (p.project_id === cur) { var t = document.createElement('i'); t.className = 'fa-solid fa-circle-check pc-tick'; card.appendChild(t); }
    card.addEventListener('click', function () { selectProject(p.project_id); });
    list.appendChild(card);
    loadProjectCount(p.project_id, count);
  });
}
function loadProjectCount(pid, el) {
  if (!AUTH || !AUTH.token) { el.textContent = '— tours'; return; }
  fetch(backendUrl() + '?action=routes&auth=' + encodeURIComponent(AUTH.token) + '&projectId=' + encodeURIComponent(pid))
    .then(function (r) { return r.json(); })
    .then(function (res) {
      var n = (res && res.ok) ? (typeof res.count === 'number' ? res.count : (res.routes ? res.routes.length : null)) : null;
      el.textContent = (n == null ? '—' : n) + ' tour' + (n === 1 ? '' : 's');
    })
    .catch(function () { el.textContent = '— tours'; });
}
function selectProject(pid) {
  if (pid !== $('projSel').value && (editingRouteId || hasUnsavedWork())) {
    if (!confirm('Switch project? The current tour will be closed' + (hasUnsavedWork() ? ' and unsaved recording discarded.' : '.'))) return;
    resetRoute();
  }
  $('projSel').value = pid;
  try { localStorage.setItem(PROJECT_KEY, pid); } catch (e) {}
  syncProjLabel();
  hide('projScreen');
}

/* ── Google Maps loader ──────────────────────────────────── */
var mapsReady = false, mapsLoading = false, mapsCbs = [];
function ensureMaps(key, cb) {
  if (mapsReady) return cb(true);
  if (!key) return cb(false);
  mapsCbs.push(cb);
  if (mapsLoading) return;
  mapsLoading = true;
  window.__gmReady = function () { mapsReady = true; mapsCbs.splice(0).forEach(function (f) { f(true); }); };
  var s = document.createElement('script');
  s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) + '&libraries=geometry&callback=__gmReady&loading=async';
  s.async = true;
  s.onerror = function () { mapsLoading = false; mapsCbs.splice(0).forEach(function (f) { f(false); }); };
  document.head.appendChild(s);
}

function showMapMsg(t) { hideLocating(); $('map').innerHTML = '<div class="map-msg">' + t + '</div>'; }

/* ── Locating overlay ────────────────────────────────────────
 * Shown from bootstrap until BOTH the map has rendered and the first GPS fix
 * is in, so the map opens already centred on the walker. After a few seconds
 * without a fix (or if location is denied) it offers "Show map anyway". */
var LASTFIX_KEY = 'tours.recorder.lastFix';
var locMapIdle = false, locHadFix = false, locDone = false, locTimer = null;
function showLocating() {
  locDone = false; $('locating').hidden = false;
  $('locating').classList.remove('out');
  clearTimeout(locTimer);
  locTimer = setTimeout(function () {
    if (locDone) return;
    $('locSub').textContent = 'Still searching — open sky helps';
    $('locSkip').hidden = false;
  }, 8000);
}
function hideLocating() {
  if (locDone) return;
  locDone = true; clearTimeout(locTimer);
  var el = $('locating');
  el.classList.add('out');
  setTimeout(function () { el.hidden = true; }, 350);
}
function maybeRevealMap() { if (locMapIdle && locHadFix) hideLocating(); }
function storedFix() {
  try { var f = JSON.parse(localStorage.getItem(LASTFIX_KEY) || 'null'); if (f && isFinite(f.lat) && isFinite(f.lng)) return f; } catch (e) {}
  return null;
}

function initMap() {
  // Open on the live fix if GPS beat the Maps script, else the last known spot.
  var start = lastFix || storedFix() || { lat: 1.3066, lng: 103.8155 };
  map = new google.maps.Map($('map'), {
    center: { lat: start.lat, lng: start.lng }, zoom: 17, mapTypeId: 'roadmap',
    disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy'
  });
  map.addListener('dragstart', function () { follow = false; });
  trackPoly = new google.maps.Polyline({ map: map, path: [], strokeColor: '#1B4332', strokeOpacity: .95, strokeWeight: 5 });
  meMarker = new google.maps.Marker({ map: map, zIndex: 999,
    icon: { path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: '#1769ff', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2.5 } });
  accCircle = new google.maps.Circle({ map: map, fillColor: '#1769ff', fillOpacity: .10, strokeColor: '#1769ff', strokeOpacity: .35, strokeWeight: 1 });
  if (lastFix) { meMarker.setPosition({ lat: lastFix.lat, lng: lastFix.lng });
    accCircle.setCenter({ lat: lastFix.lat, lng: lastFix.lng }); accCircle.setRadius(Math.max(lastFix.accuracy_m, 3)); }
  google.maps.event.addListenerOnce(map, 'idle', function () { locMapIdle = true; maybeRevealMap(); });
  $('hud').hidden = false;
}

/* ── Geolocation ─────────────────────────────────────────── */
function startGeo() {
  if (!navigator.geolocation) { toast('No geolocation on this device'); return; }
  watchId = navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
}
function onErr(e) {
  setGps(null);
  if (!locDone && e && e.code === 1) {   // PERMISSION_DENIED
    $('locTitle').textContent = 'Location access is off';
    $('locSub').textContent = 'Allow location for this site to record routes';
    $('locSkip').hidden = false;
    return;
  }
  toast('GPS error: ' + (e && e.message || e));
}
function onPos(pos) {
  var c = pos.coords;
  lastFix = { lat: c.latitude, lng: c.longitude, accuracy_m: Math.round(c.accuracy) };
  setGps(lastFix.accuracy_m);
  var ll = { lat: lastFix.lat, lng: lastFix.lng };
  if (meMarker) meMarker.setPosition(ll);
  if (accCircle) { accCircle.setCenter(ll); accCircle.setRadius(Math.max(c.accuracy, 3)); }
  if (recording) {
    trackPath.push(ll); trackPoly.setPath(trackPath); updateDist();
    saveDraft(false);   // throttled (≤ every 4s) so a lock mid-walk keeps the track
  }
  if (tourBox) checkArea();
  if (!locHadFix) {
    // First fix: jump (don't animate) so there's no slide from the default spot.
    locHadFix = true;
    if (map) map.setCenter(ll);
    maybeRevealMap();
  } else if (follow && map) map.panTo(ll);
  try { localStorage.setItem(LASTFIX_KEY, JSON.stringify({ lat: ll.lat, lng: ll.lng })); } catch (e) {}
}
function setGps(acc) {
  var dot = $('gpsDot'), txt = $('gpsText');
  if (acc == null) { dot.className = 'dot'; txt.textContent = 'no fix'; return; }
  dot.className = 'dot ' + (acc <= 10 ? 'ok' : acc <= 30 ? 'mid' : '');
  txt.textContent = '±' + acc + 'm';
}

/* ── Marker styling + focus pulse ────────────────────────── */
var CP_COLOR = '#1971C2';   // checkpoints — blue (matches the counter text)
var POI_COLOR = '#D7263D';  // primary POIs (1POI) — red
var POI2_COLOR = '#E8590C'; // secondary POIs (2POI) — orange

/* A gentle expanding/shrinking ring under each point to draw the eye (and stay
 * visible even when the blue location dot sits right on top of a fresh mark).
 * One shared rAF loop drives every halo, throttled to ~25fps. */
var pulses = [], pulseRAF = null, pulseLast = 0;
function pulseLoop(ts) {
  pulseRAF = requestAnimationFrame(pulseLoop);
  if (ts - pulseLast < 66) return;   // ~15fps is plenty for a slow, gentle pulse
  pulseLast = ts;
  var k = (1 - Math.cos((Date.now() % 2200) / 2200 * 2 * Math.PI)) / 2;  // 0→1→0
  var radius = 5 + k * 8, op = 0.55 * (1 - k);
  for (var i = 0; i < pulses.length; i++) {
    pulses[i].setRadius(radius);
    pulses[i].setOptions({ strokeOpacity: op, fillOpacity: op * 0.22 });
  }
}
function addPulse(lat, lng, color) {
  var c = new google.maps.Circle({ map: map, center: { lat: lat, lng: lng }, radius: 6, zIndex: 1,
    fillColor: color, fillOpacity: .12, strokeColor: color, strokeOpacity: .5, strokeWeight: 2, clickable: false });
  pulses.push(c);
  if (!pulseRAF) pulseRAF = requestAnimationFrame(pulseLoop);
  return c;
}
function removePulse(c) {
  if (!c) return;
  c.setMap(null);
  var i = pulses.indexOf(c); if (i >= 0) pulses.splice(i, 1);
}
function clearPulses() {
  pulses.forEach(function (c) { c.setMap(null); });
  pulses = [];
  if (pulseRAF) { cancelAnimationFrame(pulseRAF); pulseRAF = null; }
}

/* Create the numbered red POI marker + geofence ring used for both new and
 * loaded POIs, so they look identical. */
function isSecondary(m) { return m.poi_type === 'secondary'; }
function poiVisual(m, n) {
  var sec = isSecondary(m), color = sec ? POI2_COLOR : POI_COLOR;
  m.marker = new google.maps.Marker({ map: map, position: { lat: m.lat, lng: m.lng }, title: m.name, zIndex: sec ? 4 : 5,
    label: { text: String(n), color: '#fff', fontSize: sec ? '10px' : '11px', fontWeight: '700' },
    icon: { path: google.maps.SymbolPath.CIRCLE, scale: sec ? 9 : 11, fillColor: color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2.5 } });
  m.circle = new google.maps.Circle({ map: map, center: { lat: m.lat, lng: m.lng }, radius: m.geofence_radius_m,
    fillColor: color, fillOpacity: sec ? .06 : .10, strokeColor: color, strokeOpacity: sec ? .35 : .5, strokeWeight: 1, clickable: false });
  m.pulse = addPulse(m.lat, m.lng, color);
}
/* Next marker number within a POI tier (1POI and 2POI are numbered separately). */
function poiNumber(type) {
  return marks.filter(function (x) { return x.kind === 'poi' && (x.poi_type || 'primary') === type; }).length + 1;
}
function checkpointVisual(m) {
  m.marker = new google.maps.Marker({ map: map, position: { lat: m.lat, lng: m.lng }, title: 'waypoint', zIndex: 4,
    icon: { path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: CP_COLOR, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2.5 } });
  m.pulse = addPulse(m.lat, m.lng, CP_COLOR);
}

/* ── Recording + marking ─────────────────────────────────── */
var MARK_BTNS = ['cpBtn', 'poiBtn', 'poi2Btn'];

/* Record ⇄ Stop. Stop finishes the walk (opens the save sheet); cancelling that
 * sheet leaves the button on "Resume" to carry on the same walk. Marks can only
 * be dropped while recording. */
function onRecTap() {
  if (recording) { openSave(); return; }
  if (farOutside) { toast('Walk back to the tour area to record'); return; }
  if (!$('projSel').value) { toast('Pick a project first'); openProjectPicker(); return; }
  if (!editingRouteId && !tourName) { openNameSheet(); return; }
  setRecording(true);
}
function syncRecBtn() {
  $('recBtn').classList.toggle('on', recording);
  $('recBtn').querySelector('span:last-child').textContent = recording ? 'Stop' : (started ? 'Resume' : 'Record');
  $('recDot').hidden = !recording;
  MARK_BTNS.forEach(function (id) { $(id).disabled = !recording; });
}
function setRecording(on) {
  // Guard: don't let recording START while far outside a loaded tour's area.
  if (on && !recording && farOutside) { toast('Walk back to the tour area to record'); return; }
  recording = on;
  if (on) {
    started = true;
    follow = true;
    if (lastFix) { trackPath.push({ lat: lastFix.lat, lng: lastFix.lng }); trackPoly.setPath(trackPath); }
  }
  syncRecBtn();
  saveDraft(true);   // capture the record/stop transition
}

/* ── New-tour name prompt ────────────────────────────────── */
function openNameSheet() {
  $('tName').value = tourName || '';
  $('nameGo').disabled = !$('tName').value.trim();
  show('nameSheet'); setTimeout(function () { $('tName').focus(); }, 50);
}
function submitName() {
  var v = $('tName').value.trim();
  if (!v) return;
  tourName = v; syncTourLabel();
  hide('nameSheet');
  setRecording(true);
}

/* Tour picker label: "New tour", the new tour's name (tagged "new"), or the loaded tour. */
function syncTourLabel() {
  var editing = !!editingRouteId;
  $('tourBtnLabel').textContent = editing ? ((loadedRoute && loadedRoute.name) || editingRouteId) : (tourName || 'New tour');
  $('tourBtnTag').hidden = editing || !tourName;
}

function addCheckpoint() {
  if (!lastFix) return toast('Waiting for GPS fix…');
  if (farOutside) return toast('Walk back to the tour area first');
  var m = { kind: 'checkpoint', lat: lastFix.lat, lng: lastFix.lng, accuracy_m: lastFix.accuracy_m };
  checkpointVisual(m);
  marks.push(m); afterMark('Waypoint dropped');
}

var pendingPoiType = 'primary';
function openPoi(type) {
  pendingPoiType = type === 'secondary' ? 'secondary' : 'primary';
  $('poiTitle').textContent = pendingPoiType === 'secondary' ? 'Mark a secondary POI (2POI)' : 'Mark a primary POI (1POI)';
  if (!lastFix) return toast('Waiting for GPS fix…');
  if (farOutside) return toast('Walk back to the tour area first');
  pendingPoi = { lat: lastFix.lat, lng: lastFix.lng, accuracy_m: lastFix.accuracy_m };
  $('poiCoord').textContent = fmt(pendingPoi.lat) + ', ' + fmt(pendingPoi.lng) + '  (±' + pendingPoi.accuracy_m + 'm)';
  $('poiName').value = ''; $('poiCat').value = ''; $('poiBrief').value = ''; $('poiRad').value = '20';
  show('poiSheet'); setTimeout(function () { $('poiName').focus(); }, 50);
}
function savePoi() {
  var name = $('poiName').value.trim();
  if (!name) return toast('POI needs a name');
  var m = { kind: 'poi', poi_type: pendingPoiType, lat: pendingPoi.lat, lng: pendingPoi.lng, accuracy_m: pendingPoi.accuracy_m,
    name: name, category: $('poiCat').value.trim(), briefing_md: $('poiBrief').value.trim(),
    geofence_radius_m: Number($('poiRad').value) || 20 };
  poiVisual(m, poiNumber(pendingPoiType));
  marks.push(m); hide('poiSheet'); afterMark((isSecondary(m) ? '2POI' : '1POI') + ' “' + name + '” dropped');
}

function undo() {
  var m = marks[marks.length - 1];
  if (!m || m.existing) return toast('Nothing new to undo');  // never remove the loaded tour's marks
  marks.pop();
  if (m.marker) m.marker.setMap(null);
  if (m.circle) m.circle.setMap(null);
  removePulse(m.pulse);
  afterMark('Removed ' + (m.kind === 'checkpoint' ? 'waypoint' : (isSecondary(m) ? '2POI' : '1POI')));
}
function afterMark(msg) {
  updateCounts();
  $('undoBtn').disabled = !marks.some(function (m) { return !m.existing; });
  saveDraft(true);   // persist immediately after every checkpoint / POI / undo
  toast(msg);
}

function updateCounts() {
  var cp = marks.filter(function (m) { return m.kind === 'checkpoint'; }).length;
  var p1 = marks.filter(function (m) { return m.kind === 'poi' && !isSecondary(m); }).length;
  var p2 = marks.filter(function (m) { return m.kind === 'poi' && isSecondary(m); }).length;
  $('counts').innerHTML =
    '<span class="c-cp">' + cp + ' waypoint' + (cp === 1 ? '' : 's') + '</span>' +
    ' · <span class="c-poi">' + p1 + ' 1POI</span>' +
    ' · <span class="c-poi2">' + p2 + ' 2POI</span>';
}
function updateDist() {
  if (!google.maps.geometry || trackPath.length < 2) { $('dist').textContent = ''; return; }
  var m = google.maps.geometry.spherical.computeLength(trackPath.map(function (c) { return new google.maps.LatLng(c.lat, c.lng); }));
  $('dist').textContent = m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2) + ' km';
}

/* ── Save to backend ─────────────────────────────────────── */
function openSave() {
  setRecording(false);
  var editing = !!editingRouteId;
  $('saveTitle').textContent = editing ? 'Update tour' : 'Save route';
  $('rSnapRow').hidden = editing;            // merging handles geometry when editing
  $('saveMsg').textContent = '';

  if (editing) {
    var r = loadedRoute || {};
    $('rName').value = r.name || '';
    $('rDesc').value = r.description || '';
    if (r.status) $('rStatus').value = r.status;
    if (r.tracking_mode) $('rTracking').value = r.tracking_mode;
    var newPoi = marks.filter(function (m) { return m.kind === 'poi' && !m.existing; }).length;
    var exPoi  = marks.filter(function (m) { return m.kind === 'poi' && m.existing; }).length;
    $('saveSummary').textContent = exPoi + ' existing + ' + newPoi + ' new POI' + (newPoi === 1 ? '' : 's') +
      ' · ' + (trackPath.length ? trackPath.length + ' new GPS points' : 'no new path');
  } else {
    var cp = marks.filter(function (m) { return m.kind === 'checkpoint'; }).length;
    var po = marks.filter(function (m) { return m.kind === 'poi'; }).length;
    var dist = (google.maps.geometry && trackPath.length > 1)
      ? Math.round(google.maps.geometry.spherical.computeLength(trackPath.map(function (c) { return new google.maps.LatLng(c.lat, c.lng); }))) : 0;
    $('saveSummary').textContent = trackPath.length + ' GPS points · ' + cp + ' waypoints · ' + po + ' POIs · ' + dist + ' m';
    $('rName').value = tourName;
  }
  show('saveSheet'); setTimeout(function () { $('rName').focus(); }, 50);
}

function doSave() {
  var name = $('rName').value.trim();
  var msg = $('saveMsg'); msg.className = 'msg';
  if (!name) { msg.textContent = 'Route name is required.'; msg.className = 'msg err'; return; }
  if (!AUTH || !AUTH.token) { msg.textContent = 'Please sign in first.'; msg.className = 'msg err'; hide('saveSheet'); showSignIn(); return; }
  var projectId = $('projSel').value;
  if (!projectId) { msg.textContent = 'Pick a project (top bar) before saving.'; msg.className = 'msg err'; return; }

  var editing = !!editingRouteId;
  var checkpoints = marks.filter(function (m) { return m.kind === 'checkpoint'; })
    .map(function (m) { return { lat: m.lat, lng: m.lng, accuracy_m: m.accuracy_m, segment_note: 'checkpoint' }; });

  var snap = !editing && $('rSnap').checked;
  msg.textContent = editing ? 'Linking path…' : (snap ? 'Snapping path…' : 'Saving…');

  // Build the (encoded) track, then POST. `merged` is the final point array, used
  // to order POIs by their position ALONG the path (so an inserted POI lands in
  // the right sequence regardless of when it was dropped).
  var finish = function (track, distM, merged) {
    var poiMarks = marks.filter(function (m) { return m.kind === 'poi'; });
    if (merged && merged.length > 1) {
      poiMarks = poiMarks.slice().sort(function (a, b) { return alongDistance(merged, a) - alongDistance(merged, b); });
    }
    var pois = poiMarks.map(function (m) {
      var o = { name: m.name, category: m.category, poi_type: m.poi_type || 'primary', lat: m.lat, lng: m.lng, accuracy_m: m.accuracy_m, geofence_radius_m: m.geofence_radius_m, briefing_md: m.briefing_md };
      if (m.poi_id) o.poi_id = m.poi_id;   // keep existing POIs' identity on update
      return o;
    });
    var start = (merged && merged[0]) || trackPath[0] || (marks[0] ? { lat: marks[0].lat, lng: marks[0].lng } : null);
    var payload = {
      auth: AUTH.token, projectId: projectId,
      name: name, description: $('rDesc').value.trim(), status: $('rStatus').value, tracking_mode: $('rTracking').value,
      distance_m: distM, est_duration_min: distM ? Math.max(1, Math.round(distM / 80)) : '',
      start_lat: start ? start.lat : '', start_lng: start ? start.lng : '',
      track_polyline: track, waypoints: checkpoints, pois: pois
    };
    if (editing) {
      payload.action = 'route.update'; payload.routeId = editingRouteId;
      if (loadedVersion != null) payload.expected_content_version = loadedVersion;
    } else {
      payload.action = 'route.create';
      // Stable per-route idempotency key: reused across retries (and reloads, via
      // the draft) so a dropped response can't create duplicate routes. The
      // backend returns the first route it made for this key instead of a copy.
      if (!saveOpId) saveOpId = uuid();
      payload.client_op_id = saveOpId;
    }
    msg.textContent = 'Saving…';
    postJson(payload, editing ? 'route.update' : 'route.create')
      .then(function (res) {
        if (editing && res.content_version != null) loadedVersion = Number(res.content_version);
        if (editing && loadedRoute) { loadedRoute.name = name; syncTourLabel(); }
        saveOpId = null; clearDraft();   // committed — this route is no longer an unsaved draft
        hide('saveSheet'); showResult(res.routeId || editingRouteId, editing);
      })
      .catch(function (e) { msg.textContent = 'Failed: ' + e.message + ' — tap Save to retry (no duplicate will be created).'; msg.className = 'msg err'; });
  };
  var onErr = function (err) { msg.textContent = err; msg.className = 'msg err'; };

  if (editing) buildEditedTrack(finish, onErr);
  else buildTrack(snap, checkpoints, finish, onErr);
}

/* Produce the (encoded polyline, distance) to save. With snap=false, that's the
 * raw recorded GPS track. With snap=true, ask the Directions API for a WALKING
 * path through the checkpoints and use that instead (falls back with an error
 * message if Directions is unavailable). cb(track, distM); errCb(message). */
function buildTrack(snap, checkpoints, cb, errCb) {
  var encode = function (pts) { return google.maps.geometry.encoding.encodePath(pts.map(function (c) { return new google.maps.LatLng(c.lat, c.lng); })); };
  var len = function (pts) { return Math.round(google.maps.geometry.spherical.computeLength(pts.map(function (c) { return new google.maps.LatLng(c.lat, c.lng); }))); };

  if (!snap) {
    var track = (google.maps.geometry && trackPath.length) ? encode(trackPath) : '';
    cb(track, trackPath.length > 1 ? len(trackPath) : '', trackPath);
    return;
  }
  if (checkpoints.length < 2) { errCb('Need ≥2 waypoints to snap a path.'); return; }
  var wp = checkpoints.slice(0, 25);
  new google.maps.DirectionsService().route({
    origin: { lat: wp[0].lat, lng: wp[0].lng },
    destination: { lat: wp[wp.length - 1].lat, lng: wp[wp.length - 1].lng },
    waypoints: wp.slice(1, -1).map(function (c) { return { location: { lat: c.lat, lng: c.lng }, stopover: false }; }),
    travelMode: google.maps.TravelMode.WALKING
  }, function (result, status) {
    if (status !== 'OK' || !result.routes[0]) { errCb('Directions failed (' + status + '). Enable the Directions API for this key, or uncheck snap.'); return; }
    var ov = result.routes[0].overview_path.map(function (ll) { return { lat: ll.lat(), lng: ll.lng() }; });
    cb(encode(ov), len(ov), ov);
  });
}

function showResult(routeId, editing) {
  $('resTitle').textContent = editing ? 'Tour updated' : 'Route saved';
  $('resBody').textContent = editing
    ? 'Updated “' + routeId + '”. The dashboard now shows the extended path and the new POIs.'
    : 'Created “' + routeId + '”. It now renders on the dashboard map.';
  $('resOpen').href = backendUrl() || '#';
  show('resultSheet');
}
function resetRoute() {
  marks.forEach(function (m) { if (m.marker) m.marker.setMap(null); if (m.circle) m.circle.setMap(null); });
  clearPulses();
  marks = []; trackPath = []; if (trackPoly) trackPoly.setPath([]);
  recording = false; started = false;
  // Starting fresh: drop the idempotency key + any recovered draft so the next
  // route is genuinely new (a new save mints a new client_op_id).
  saveOpId = null; clearDraft();
  // Drop any loaded-tour state so the next route starts fresh.
  editingRouteId = null; loadedRoute = null; loadedVersion = null;
  existingPath = []; if (existingPoly) { existingPoly.setMap(null); existingPoly = null; }
  tourBox = null; clearLinkTemps();
  tourName = ''; syncTourLabel();
  setFar(false);
  $('recBtn').disabled = false; syncRecBtn();
  $('undoBtn').disabled = true;
  updateCounts(); $('dist').textContent = '';
}

/* ── Draft recovery ──────────────────────────────────────────
 * Called once the map is live. If an autosaved draft holds real work, offer to
 * bring it back rather than silently resuming (the user may have meant to start
 * fresh). Rebuilds every mark + the GPS track + any editing context. */
var pendingDraft = null;
function maybeOfferRestore() {
  var d = loadDraft();
  if (!d || !Array.isArray(d.marks)) return;
  var hasWork = (d.trackPath && d.trackPath.length) || d.marks.some(function (m) { return !m.existing; });
  if (!hasWork) { clearDraft(); return; }
  if (d.savedAt && (Date.now() - d.savedAt) > 24 * 3600 * 1000) { clearDraft(); return; }  // stale → drop
  pendingDraft = d;
  var np = d.marks.filter(function (m) { return m.kind === 'poi' && !m.existing; }).length;
  var cp = d.marks.filter(function (m) { return m.kind === 'checkpoint' && !m.existing; }).length;
  var tn = d.tourName || (d.loadedRoute && d.loadedRoute.name) || '';
  var pts = d.trackPath ? d.trackPath.length : 0;
  var proj = projName(d.projectId) || d.projectId || '';
  $('resumeSummary').textContent = pts + ' GPS point' + (pts === 1 ? '' : 's') + ' · ' +
    np + ' POI' + (np === 1 ? '' : 's') + ' · ' + cp + ' waypoint' + (cp === 1 ? '' : 's') +
    (tn ? ' · “' + tn + '”' : '') + (d.editingRouteId ? ' · editing' : '') + (proj ? ' · ' + proj : '') +
    (d.savedAt ? ' · ' + timeAgo(d.savedAt) : '');
  show('resumeSheet');
}
function restoreDraft(d) {
  resetRoute();   // clears the map + state (and the on-disk draft; d is already in memory)
  if (d.projectId) {
    var sel = $('projSel');
    var known = Array.prototype.some.call(sel.options, function (o) { return o.value === d.projectId; });
    if (known) { sel.value = d.projectId; try { localStorage.setItem(PROJECT_KEY, d.projectId); } catch (e) {} syncProjLabel(); }
  }
  saveOpId = d.saveOpId || null;
  tourName = d.tourName || '';

  if (d.editingRouteId) {
    editingRouteId = d.editingRouteId;
    loadedRoute = d.loadedRoute || null;
    loadedVersion = (d.loadedVersion != null && d.loadedVersion !== '') ? Number(d.loadedVersion) : null;
    existingPath = Array.isArray(d.existingPath) ? d.existingPath.map(function (c) { return { lat: Number(c.lat), lng: Number(c.lng) }; }) : [];
    if (existingPath.length) {
      existingPoly = new google.maps.Polyline({ map: map, path: existingPath,
        strokeColor: '#6B7B73', strokeOpacity: .9, strokeWeight: 5,
        icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: .9, scale: 2.5 }, offset: '0', repeat: '14px' }] });
    }
  }
  syncTourLabel();

  d.marks.forEach(function (md) {
    var m = { kind: md.kind, existing: !!md.existing, lat: Number(md.lat), lng: Number(md.lng),
      accuracy_m: md.accuracy_m, name: md.name || '', category: md.category || '',
      briefing_md: md.briefing_md || '', geofence_radius_m: Number(md.geofence_radius_m) || 20 };
    if (md.poi_id) m.poi_id = md.poi_id;
    if (m.kind === 'poi') { m.poi_type = md.poi_type === 'secondary' ? 'secondary' : 'primary'; poiVisual(m, poiNumber(m.poi_type)); }
    else checkpointVisual(m);
    marks.push(m);
  });

  trackPath = Array.isArray(d.trackPath) ? d.trackPath.map(function (c) { return { lat: Number(c.lat), lng: Number(c.lng) }; }) : [];
  if (trackPoly) trackPoly.setPath(trackPath);
  started = !!d.started; recording = false;

  $('hud').hidden = false;
  $('recBtn').disabled = false; syncRecBtn();
  $('undoBtn').disabled = !marks.some(function (m) { return !m.existing; });

  computeTourBox(); updateCounts(); updateDist();
  if (tourBox) fitTour();
  if (lastFix) checkArea();
  saveDraft(true);   // re-persist under the recovered state
  toast('Recovered your unsaved route');
}

/* ── Open & extend an existing tour ──────────────────────── */
var linkAbort = null;   // call to cancel the in-progress conflict resolver

function openTourPicker() {
  if (!AUTH || !AUTH.token) return showSignIn();
  var pid = $('projSel').value;
  if (!pid) return toast('Pick a project first');
  var list = $('tourList'); list.innerHTML = '';
  list.appendChild(newTourItem());
  list.insertAdjacentHTML('beforeend', '<p class="hint" id="tourLoading">Loading tours…</p>');
  show('tourSheet');
  fetch(backendUrl() + '?action=routes&auth=' + encodeURIComponent(AUTH.token) + '&projectId=' + encodeURIComponent(pid))
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (!res || !res.ok) throw new Error((res && res.error) || 'could not load tours');
      renderTourList(res.routes || []);
    })
    .catch(function (e) { var l = $('tourLoading'); if (l) l.outerHTML = '<p class="msg err">' + esc(e.message) + '</p>'; });
}

/* Discarding unsaved work (or leaving a loaded tour) needs a confirm. */
function okToLeaveTour() {
  if (!hasUnsavedWork()) return true;
  return confirm('Discard the unsaved recording on this tour?');
}
function newTourItem() {
  var btn = document.createElement('button');
  btn.className = 'tour-item new' + (!editingRouteId ? ' sel' : '');
  btn.innerHTML = '<span class="tour-name"><i class="fa-solid fa-plus"></i>&nbsp; New tour</span>' +
    '<span class="tour-meta">Record a fresh route</span>';
  btn.addEventListener('click', function () {
    hide('tourSheet');
    if (!editingRouteId) return;              // already on a new tour — keep any work
    if (!okToLeaveTour()) return;
    resetRoute(); toast('New tour');
  });
  return btn;
}

function renderTourList(routes) {
  var list = $('tourList');
  var l = $('tourLoading'); if (l) l.remove();
  if (!routes.length) { list.insertAdjacentHTML('beforeend', '<p class="hint">No saved tours in this project yet.</p>'); return; }
  routes.forEach(function (r) {
    var dm = Number(r.distance_m);
    var dist = (isNaN(dm) || !dm) ? '—' : (dm < 1000 ? Math.round(dm) + ' m' : (dm / 1000).toFixed(2) + ' km');
    var btn = document.createElement('button'); btn.className = 'tour-item' + (r.route_id === editingRouteId ? ' sel' : '');
    btn.innerHTML = '<span class="tour-name">' + esc(r.name || r.route_id) + '</span>' +
      '<span class="tour-meta">' + esc(r.status || 'draft') + ' · ' + (r.poi_count || 0) + ' POI · ' + dist + '</span>';
    btn.addEventListener('click', function () {
      if (r.route_id === editingRouteId) { hide('tourSheet'); return; }
      if (!okToLeaveTour()) return;
      loadTour(r.route_id);
    });
    list.appendChild(btn);
  });
}

function loadTour(routeId) {
  var pid = $('projSel').value;
  var list = $('tourList'); list.innerHTML = '<p class="hint">Opening…</p>';
  follow = false;
  fetch(backendUrl() + '?action=route&id=' + encodeURIComponent(routeId) + '&auth=' + encodeURIComponent(AUTH.token) + '&projectId=' + encodeURIComponent(pid))
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (!res || !res.ok) throw new Error((res && res.error) || 'could not open tour');
      hydrateTour(res); hide('tourSheet');
    })
    .catch(function (e) { list.innerHTML = '<p class="msg err">' + esc(e.message) + '</p>'; });
}

/* Load a backend route bundle into the live editing state. */
function hydrateTour(b) {
  resetRoute();
  var r = b.route || {};
  editingRouteId = r.route_id;
  loadedRoute = r;
  loadedVersion = (r.content_version != null && r.content_version !== '') ? Number(r.content_version) : null;

  existingPath = [];
  if (r.track_polyline && google.maps.geometry && google.maps.geometry.encoding) {
    try {
      existingPath = google.maps.geometry.encoding.decodePath(r.track_polyline)
        .map(function (ll) { return { lat: ll.lat(), lng: ll.lng() }; });
    } catch (e) { existingPath = []; }
  }
  existingPoly = new google.maps.Polyline({ map: map, path: existingPath,
    strokeColor: '#6B7B73', strokeOpacity: .9, strokeWeight: 5,
    icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: .9, scale: 2.5 }, offset: '0', repeat: '14px' }] });

  (b.pois || []).forEach(function (p) { addExistingPoi(p); });
  (b.waypoints || []).forEach(function (w) { addExistingCheckpoint(w); });

  computeTourBox();
  syncTourLabel();
  $('hud').hidden = false;
  $('undoBtn').disabled = true;
  updateCounts(); fitTour();
  if (lastFix) checkArea();
  toast('Opened “' + (r.name || editingRouteId) + '” — tap Record to add POIs or extend it');
}

function addExistingPoi(p) {
  var lat = Number(p.lat), lng = Number(p.lng);
  if (isNaN(lat) || isNaN(lng)) return;
  var type = String(p.poi_type || 'primary').toLowerCase() === 'secondary' ? 'secondary' : 'primary';
  var n = poiNumber(type);
  var m = { kind: 'poi', poi_type: type, existing: true, poi_id: p.poi_id, lat: lat, lng: lng, accuracy_m: num0(p.accuracy_m),
    name: p.name || ('POI ' + n), category: p.category || '', briefing_md: p.briefing_md || '',
    geofence_radius_m: Number(p.geofence_radius_m) || 20 };
  poiVisual(m, n);
  marks.push(m);
}

function addExistingCheckpoint(w) {
  var lat = Number(w.lat), lng = Number(w.lng);
  if (isNaN(lat) || isNaN(lng)) return;
  var m = { kind: 'checkpoint', existing: true, lat: lat, lng: lng, accuracy_m: num0(w.accuracy_m) };
  checkpointVisual(m);
  marks.push(m);
}

/* ── "Go back to the tour area" guard ────────────────────── */
function computeTourBox() {
  var box = new google.maps.LatLngBounds();
  var any = false;
  existingPath.forEach(function (c) { box.extend(c); any = true; });
  marks.forEach(function (m) { box.extend({ lat: m.lat, lng: m.lng }); any = true; });
  tourBox = any ? box : null;
}
function fitTour() { if (tourBox) { follow = false; map.fitBounds(tourBox, 64); } }

function checkArea() {
  if (!tourBox || !lastFix || !google.maps.geometry) return;
  var ne = tourBox.getNorthEast(), sw = tourBox.getSouthWest();
  var midLat = (ne.lat() + sw.lat()) / 2;
  var diag = dist({ lat: sw.lat(), lng: sw.lng() }, { lat: ne.lat(), lng: ne.lng() });
  var margin = Math.max(AREA_MARGIN_M, diag * 0.5);   // generous: half the tour's own span, min 150 m
  var dLat = margin / 111320;
  var dLng = margin / (111320 * Math.cos(midLat * Math.PI / 180));
  var exp = new google.maps.LatLngBounds(
    { lat: sw.lat() - dLat, lng: sw.lng() - dLng },
    { lat: ne.lat() + dLat, lng: ne.lng() + dLng });
  setFar(!exp.contains({ lat: lastFix.lat, lng: lastFix.lng }));
}

function setFar(on) {
  on = !!on;
  if (on === farOutside) return;
  farOutside = on;
  $('farFlag').hidden = !on;
  if (on) {
    if (recording) setRecording(false);                 // stop logging junk while away
    ['recBtn'].concat(MARK_BTNS).forEach(function (id) { $(id).disabled = true; });
  } else {
    $('recBtn').disabled = false;
    syncRecBtn();
  }
}

/* ── Splice a freshly-recorded segment into the existing path ─ */
/* Decide how the new walk attaches to the base path, returning an ordered list
 * of pieces (point arrays) interleaved with {join} markers that still need a
 * connector chosen (straight or a Google walking path). */
function planSplice(base, seg) {
  var iEntry = nearestIndex(base, seg[0]);
  var iExit  = nearestIndex(base, seg[seg.length - 1]);
  var startJoined = dist(base[iEntry], seg[0]) <= NEAR_ATTACH_M;
  var endJoined   = dist(base[iExit], seg[seg.length - 1]) <= NEAR_ATTACH_M;

  if (startJoined && endJoined) {
    // Detour / insert between two points on the base → replace that stretch.
    var lo = Math.min(iEntry, iExit), hi = Math.max(iEntry, iExit);
    var s = seg;
    if (dist(seg[0], base[lo]) > dist(seg[seg.length - 1], base[lo])) s = seg.slice().reverse();
    return { pieces: [
      base.slice(0, lo + 1),
      { join: true, from: base[lo], to: s[0] },
      s,
      { join: true, from: s[s.length - 1], to: base[hi] },
      base.slice(hi)
    ] };
  }
  if (endJoined && !startJoined) {
    // Prepend: the new walk leads into the start of the existing path.
    return { pieces: [
      seg,
      { join: true, from: seg[seg.length - 1], to: base[iExit] },
      base.slice(iExit)
    ] };
  }
  // Append (default, incl. a fully detached new piece): base, then the new walk.
  return { pieces: [
    base.slice(0, iEntry + 1),
    { join: true, from: base[iEntry], to: seg[0] },
    seg
  ] };
}

function assembleMerged(pieces, connectors) {
  var out = [], ji = 0;
  pieces.forEach(function (pc) {
    if (pc && pc.join) { out = out.concat(connectors[ji++] || []); }
    else out = out.concat(pc);
  });
  // Drop near-coincident consecutive points so joins don't leave spikes.
  var clean = [];
  out.forEach(function (p) {
    var last = clean[clean.length - 1];
    if (!last || dist(last, p) > 0.5) clean.push(p);
  });
  return clean;
}

/* Build the merged + encoded track for an edited tour, resolving any ambiguous
 * joins through the conflict resolver. cb(encoded, distM, mergedArray). */
function buildEditedTrack(cb, errCb) {
  var encode = function (pts) { return google.maps.geometry.encoding.encodePath(pts.map(LL)); };
  var lenM = function (pts) { return pts.length > 1 ? Math.round(pathLen(pts)) : ''; };

  // No real new walk (e.g. Record → drop POIs → Stop on the spot) → keep the loaded path.
  if (trackPath.length < 2 || pathLen(trackPath) < 15) {
    cb(existingPath.length ? encode(existingPath) : '', lenM(existingPath), existingPath);
    return;
  }
  if (!existingPath.length) { cb(encode(trackPath), lenM(trackPath), trackPath); return; }

  var plan = planSplice(existingPath, trackPath);
  resolveJoins(plan.pieces, function (connectors) {
    var merged = assembleMerged(plan.pieces, connectors);
    cb(encode(merged), lenM(merged), merged);
  }, errCb);
}

/* Resolve each join in order: small gaps join straight automatically; wide gaps
 * open the resolver so the recordist picks a connecting path. */
function resolveJoins(pieces, done, fail) {
  var joins = pieces.filter(function (p) { return p && p.join; });
  var connectors = [], i = 0;
  (function next() {
    if (i >= joins.length) { done(connectors); return; }
    resolveOneJoin(joins[i], function (conn) {
      if (conn === null) { fail('Walk the missing link, then tap Stop again.'); return; }
      connectors[i] = conn; i++; next();
    });
  })();
}

function resolveOneJoin(join, cb) {
  if (dist(join.from, join.to) <= LINK_GAP_M) { cb([]); return; }   // close enough → straight
  fetchAlternatives(join.from, join.to, function (alts) { showLinkResolver(join, alts, cb); });
}

/* Ask the Directions API for up to 3 alternative WALKING paths between two points. */
function fetchAlternatives(from, to, cb) {
  if (!google.maps.DirectionsService) { cb([]); return; }
  new google.maps.DirectionsService().route({
    origin: LL(from), destination: LL(to),
    travelMode: google.maps.TravelMode.WALKING, provideRouteAlternatives: true
  }, function (res, status) {
    if (status !== 'OK' || !res || !res.routes || !res.routes.length) { cb([]); return; }
    cb(res.routes.slice(0, 3).map(function (r) {
      return r.overview_path.map(function (ll) { return { lat: ll.lat(), lng: ll.lng() }; });
    }));
  });
}

/* Draw each candidate connector on the map and list them; the recordist taps one.
 * cb(connector) with the interior points to splice in, or cb(null) to re-record. */
function showLinkResolver(join, alts, cb) {
  clearLinkTemps();
  var colors = ['#1769ff', '#E8590C', '#7048E8', '#0CA678'];
  var opts = [{ label: 'Straight line', sub: Math.round(dist(join.from, join.to)) + ' m',
    color: colors[0], path: [join.from, join.to], connector: [] }];
  alts.forEach(function (a, i) {
    opts.push({ label: 'Walking path ' + (i + 1), sub: Math.round(pathLen(a)) + ' m',
      color: colors[(i + 1) % colors.length], path: a, connector: a.slice(1, -1) });
  });

  var bounds = new google.maps.LatLngBounds();
  opts.forEach(function (o) {
    o.path.forEach(function (p) { bounds.extend(p); });
    linkTempPolys.push(new google.maps.Polyline({ map: map, path: o.path, strokeColor: o.color, strokeOpacity: .95, strokeWeight: 5,
      icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 }, offset: '0', repeat: '12px' }] }));
  });
  follow = false; map.fitBounds(bounds, 70);

  var settled = false;
  function pick(conn) { if (settled) return; settled = true; clearLinkTemps(); hide('linkSheet'); linkAbort = null; cb(conn); }

  $('linkHint').textContent = alts.length
    ? 'Your new walk doesn’t quite meet the existing path. Pick the link to use — each option is drawn on the map.'
    : 'Your new walk doesn’t quite meet the existing path, and Google had no walking route here. Join them with a straight line, or re-record the link.';
  var list = $('linkList'); list.innerHTML = '';
  opts.forEach(function (o) {
    var btn = document.createElement('button'); btn.className = 'link-item';
    btn.innerHTML = '<span class="link-swatch" style="background:' + o.color + '"></span><span>' + esc(o.label) + '</span><span class="link-sub">' + o.sub + '</span>';
    btn.addEventListener('click', function () { pick(o.connector); });
    list.appendChild(btn);
  });
  linkAbort = function () { pick(null); };
  show('linkSheet');
}

function clearLinkTemps() { linkTempPolys.forEach(function (p) { p.setMap(null); }); linkTempPolys = []; }
function cancelLinkResolve() { if (linkAbort) linkAbort(); else hide('linkSheet'); }

/* ── Geometry helpers ────────────────────────────────────── */
function LL(c) { return new google.maps.LatLng(c.lat, c.lng); }
function dist(a, b) { return google.maps.geometry.spherical.computeDistanceBetween(LL(a), LL(b)); }
function pathLen(pts) { var s = 0; for (var i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); return s; }
function nearestIndex(path, pt) {
  var bi = 0, bd = Infinity;
  for (var i = 0; i < path.length; i++) { var d = dist(path[i], pt); if (d < bd) { bd = d; bi = i; } }
  return bi;
}
/* Cumulative distance from the path start to the vertex nearest `pt` — used to
 * order POIs along the merged path. */
function alongDistance(path, pt) {
  var best = Infinity, bestCum = 0, cum = 0;
  for (var i = 0; i < path.length; i++) {
    if (i > 0) cum += dist(path[i - 1], path[i]);
    var d = dist(path[i], { lat: pt.lat, lng: pt.lng });
    if (d < best) { best = d; bestCum = cum; }
  }
  return bestCum;
}
function num0(v) { var n = Number(v); return isNaN(n) ? '' : n; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

/* ── Profile balloon (identity + sign out) ──── */
function toggleProfile() {
  var pop = $('profilePop');
  if (!pop.hidden) { pop.hidden = true; return; }
  setProfile((AUTH && (AUTH.name || AUTH.email)) || '', (AUTH && AUTH.email) || '');
  pop.hidden = false;
}
function signOut() { clearSession(); hide('profilePop'); showSignIn('Signed out.'); }

/* ── Diagnostics (recent errors) ─────────────────────────── */
function openDiagnostics() {
  hide('profilePop');
  var log = getErrorLog().slice().reverse();   // newest first
  var body = $('diagBody');
  if (!log.length) { body.textContent = 'No errors recorded. 🎉'; }
  else {
    body.textContent = log.map(function (e) {
      var when = e.t ? e.t.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '';
      var ex = e.extra ? ('  [' + Object.keys(e.extra).map(function (k) { return k + '=' + e.extra[k]; }).join(', ') + ']') : '';
      return when + '  ' + (e.ctx || '?') + '\n  ' + e.msg + ex;
    }).join('\n\n');
  }
  show('diagScreen');
}
function copyDiagnostics() {
  var log = getErrorLog();
  var text = 'Aisee Tours Recorder — error log (' + log.length + ')\n' + navigator.userAgent + '\n\n' + JSON.stringify(log, null, 2);
  var done = function () { toast('Copied to clipboard'); };
  try { navigator.clipboard.writeText(text).then(done, function () { toast('Copy failed — select the text manually'); }); }
  catch (e) { toast('Copy not supported — select the text manually'); }
}

/* ── UI wiring ───────────────────────────────────────────── */
function wireUi() {
  $('locSkip').addEventListener('click', hideLocating);
  $('recBtn').addEventListener('click', onRecTap);
  $('cpBtn').addEventListener('click', addCheckpoint);
  $('poiBtn').addEventListener('click', function () { openPoi('primary'); });
  $('poi2Btn').addEventListener('click', function () { openPoi('secondary'); });
  $('undoBtn').addEventListener('click', undo);
  $('profileBtn').addEventListener('click', toggleProfile);
  $('tourBtn').addEventListener('click', openTourPicker);
  $('tName').addEventListener('input', function () { $('nameGo').disabled = !$('tName').value.trim(); });
  $('tName').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitName(); });
  $('nameGo').addEventListener('click', submitName);
  $('linkRerec').addEventListener('click', cancelLinkResolve);
  $('helpBtn').addEventListener('click', function () { show('helpScreen'); });
  $('helpClose').addEventListener('click', function () { hide('helpScreen'); });
  $('projBtn').addEventListener('click', openProjectPicker);
  $('projClose').addEventListener('click', function () { hide('projScreen'); });
  $('poiSave').addEventListener('click', savePoi);
  $('saveGo').addEventListener('click', doSave);
  $('signinBtn').addEventListener('click', signIn);
  $('signOutBtn').addEventListener('click', signOut);
  $('resNew').addEventListener('click', resetRoute);
  $('diagBtn').addEventListener('click', openDiagnostics);
  $('diagClose').addEventListener('click', function () { hide('diagScreen'); });
  $('diagCopy').addEventListener('click', copyDiagnostics);
  $('diagClear').addEventListener('click', function () { clearErrorLog(); openDiagnostics(); toast('Error log cleared'); });
  $('resumeGo').addEventListener('click', function () { hide('resumeSheet'); if (pendingDraft) { restoreDraft(pendingDraft); pendingDraft = null; } });
  $('resumeDiscard').addEventListener('click', function () { hide('resumeSheet'); pendingDraft = null; clearDraft(); toast('Discarded the unsaved route'); });
  document.querySelectorAll('[data-close]').forEach(function (b) {
    b.addEventListener('click', function () { hide(b.getAttribute('data-close')); });
  });

  // Last-ditch persistence: flush the draft when the tab is hidden or torn down,
  // which on iOS is the moment before the OS may evict a backgrounded page.
  document.addEventListener('visibilitychange', function () { if (document.hidden) saveDraft(true); });
  window.addEventListener('pagehide', function () { saveDraft(true); });

  // Dismiss the profile balloon on an outside click or Escape.
  document.addEventListener('click', function (e) {
    if ($('profilePop').hidden) return;
    if (e.target.closest('#profilePop') || e.target.closest('#profileBtn')) return;
    $('profilePop').hidden = true;
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { $('profilePop').hidden = true; hide('helpScreen'); hide('projScreen'); }
  });
}

/* ── Tiny helpers ────────────────────────────────────────── */
function show(id) { $(id).hidden = false; }
function hide(id) { $(id).hidden = true; }
function fmt(n) { return Number(n).toFixed(5); }
function timeAgo(ms) {
  var s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
}
var toastT;
function toast(t) { var el = $('toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(function () { el.classList.remove('show'); }, 1900); }
