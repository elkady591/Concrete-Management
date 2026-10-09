/**
 * Pour Tracker — shared state for ALL devices (Concrete Management copy).
 *
 * Keeps the dashboard's Done marks + manual Required/Rate, the users list and the edit log,
 * so a pour closed on one device disappears on every device.
 *
 * Everything is stored in this script's own PROPERTIES (no spreadsheet). That is deliberate:
 * PropertiesService / CacheService / LockService / ContentService need NO Google permissions,
 * so deploying this web app never shows the "Google hasn't verified this app" consent screen.
 * Do not add spreadsheet, Drive or URL-fetch services here — any of them brings that screen back
 * (and don't even name those services in a comment: the scope scanner reads comments too).
 *
 * ── SETUP (once) ────────────────────────────────────────────────────────────
 *  1. script.google.com ▸ New project ▸ paste ALL of this file ▸ Save.
 *  2. Deploy ▸ New deployment ▸ (gear ⚙) ▸ Web app
 *        Execute as    : Me
 *        Who has access: Anyone
 *     ▸ Deploy.
 *  3. Copy the "Web app" URL (ends with /exec) into the dashboard's Sync URL.
 * ────────────────────────────────────────────────────────────────────────────
 */

var TYPES = ['done', 'req', 'rate'];
var P_STATE = 'S|';                                       // S|<type>|<key>  -> value
var P_USER = 'U|';                                        // U|<deviceId>    -> JSON {name,lastSeen,blocked,ip}
var P_LOG = 'L|';                                         // L|<n>           -> JSON [when,who,type,key,value]
var P_LOGN = 'LOGN';                                      // number of the newest log entry

function props_() { return PropertiesService.getScriptProperties(); }

function readAll_() {
  var out = { done: {}, req: {}, rate: {} };
  var all = props_().getProperties();
  for (var k in all) {
    if (k.indexOf(P_STATE) !== 0) continue;
    var rest = k.substring(P_STATE.length), cut = rest.indexOf('|');
    if (cut < 0) continue;
    var type = rest.substring(0, cut), key = rest.substring(cut + 1), val = String(all[k]).trim();
    if (TYPES.indexOf(type) < 0 || !key || val === '') continue;
    out[type][key] = (type === 'done') ? true : Number(val);
  }
  return out;
}

/** Insert / update / delete one (type,key). Empty value = delete. */
function writeOne_(type, key, value) {
  if (TYPES.indexOf(type) < 0 || !key) return;
  var name = P_STATE + type + '|' + key;
  if (value === '' || value === null || value === undefined) props_().deleteProperty(name);
  else props_().setProperty(name, String(value));
}

/** Delete every entry of one type (used by "Reset done marks"). */
function clearType_(type) {
  if (TYPES.indexOf(type) < 0) return;
  var p = props_(), all = p.getProperties(), prefix = P_STATE + type + '|';
  for (var k in all) if (k.indexOf(prefix) === 0) p.deleteProperty(k);
}

/* ── Presence: how many devices have the dashboard open right now ──────────────
   Lives in the script cache, so a heartbeat every 30s never touches the stored state.
   Each device pings with its own id; a device counts as "open" until PRESENCE_TTL_MS passes
   with no ping (i.e. it drops off ~90s after the app is closed). */
var PRESENCE_TTL_MS = 90 * 1000;
var PRESENCE_KEY = 'presence';

/** Heartbeat. Stores {deviceId: [lastSeenMs, name, ip]} in the cache and returns
 *  { online: <count>, who: [{name, seen, ip}] } — the admin panel lists the names. */
function ping_(who, name, ip) {
  var cache = CacheService.getScriptCache();
  var lock = LockService.getScriptLock();
  var gotLock = false;
  try { lock.waitLock(5000); gotLock = true; } catch (e) {}
  var live = {};
  try {
    var map = {};
    var raw = cache.get(PRESENCE_KEY);
    if (raw) { try { map = JSON.parse(raw) || {}; } catch (e2) { map = {}; } }
    var now = new Date().getTime();
    if (who) map[who] = [now, String(name || ''), String(ip || '')];
    for (var k in map) {                                  // drop devices that stopped pinging
      var v = map[k];
      if (v && v.length && now - Number(v[0]) < PRESENCE_TTL_MS) live[k] = [Number(v[0]), String(v[1] || ''), String(v[2] || '')];
    }
    cache.put(PRESENCE_KEY, JSON.stringify(live), 600);
  } finally {
    if (gotLock) { try { lock.releaseLock(); } catch (e3) {} }
  }
  var n = 0, list = [];
  for (var k2 in live) { n++; list.push({ name: live[k2][1] || '—', seen: live[k2][0], ip: live[k2][2] || '' }); }
  list.sort(function (a, b) { return b.seen - a.seen; });
  return { online: n, who: list };
}

/* ── Single admin lock: only one device may hold admin mode at a time ─────────
   Lives in the cache. The holder's heartbeat (ping with admin=1) keeps the lock alive;
   if they stop for ADMIN_TTL_MS the lock frees so someone else can take it. */
var ADMIN_KEY = 'adminHolder';
var ADMIN_TTL_MS = 120 * 1000;
function adminClaim_(dev, name) {
  var cache = CacheService.getScriptCache();
  var lock = LockService.getScriptLock(), got = false;
  try { lock.waitLock(5000); got = true; } catch (e) {}
  try {
    var now = new Date().getTime(), raw = cache.get(ADMIN_KEY), h = null;
    if (raw) { try { h = JSON.parse(raw); } catch (e2) {} }
    if (h && h.dev && h.dev !== dev && (now - Number(h.ts || 0) < ADMIN_TTL_MS)) {
      // ok stays true: the "held" flag carries the real answer.
      return { ok: true, held: true, by: (h.name || '') };     // someone else holds it
    }
    cache.put(ADMIN_KEY, JSON.stringify({ dev: dev, name: String(name || ''), ts: now }), 600);
    return { ok: true, held: false };
  } finally { if (got) { try { lock.releaseLock(); } catch (e3) {} } }
}
function adminRefresh_(dev, name) {                            // ping with admin=1 -> keep the holder alive
  var cache = CacheService.getScriptCache(), raw = cache.get(ADMIN_KEY), now = new Date().getTime();
  if (!raw) { cache.put(ADMIN_KEY, JSON.stringify({ dev: dev, name: String(name || ''), ts: now }), 600); return; }
  var h = null; try { h = JSON.parse(raw); } catch (e) {}
  if (h && h.dev === dev) { h.ts = now; if (name) h.name = String(name); cache.put(ADMIN_KEY, JSON.stringify(h), 600); }
}
function adminRelease_(dev) {
  var cache = CacheService.getScriptCache(), raw = cache.get(ADMIN_KEY);
  if (!raw) return; var h = null; try { h = JSON.parse(raw); } catch (e) {}
  if (h && h.dev === dev) cache.remove(ADMIN_KEY);
}

/* ── Users registry: remember each visitor's name by their DEVICE id, and let the admin block a device ──
   Keyed by device, not IP — a whole office shares one public IP. The IP the client looked up is kept
   only as info for the admin. A deterrent, not hard security. */
function userGet_(dev) {
  if (!dev) return null;
  var raw = props_().getProperty(P_USER + dev);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function userPut_(dev, u) { props_().setProperty(P_USER + dev, JSON.stringify(u)); }
function userUpsert_(dev, name, ip) {
  if (!dev) return;
  var u = userGet_(dev) || { name: '', blocked: false, ip: '' };
  if (name) u.name = String(name);
  if (ip) u.ip = String(ip);
  u.lastSeen = new Date().getTime();
  userPut_(dev, u);
}
function userLookup_(dev) {
  var u = userGet_(dev);
  return u ? { dev: dev, name: String(u.name || ''), blocked: !!u.blocked } : null;
}
function usersAll_() {
  var all = props_().getProperties(), out = [];
  for (var k in all) {
    if (k.indexOf(P_USER) !== 0) continue;
    var u = null; try { u = JSON.parse(all[k]); } catch (e) {}
    if (!u) continue;
    out.push({ dev: k.substring(P_USER.length), name: String(u.name || ''), ip: String(u.ip || ''),
      lastSeen: Number(u.lastSeen || 0), blocked: !!u.blocked });
  }
  out.sort(function (a, b) { return (b.lastSeen || 0) - (a.lastSeen || 0); });
  return out;
}
function userSetBlocked_(dev, blocked) {
  if (!dev) return;
  var u = userGet_(dev) || { name: '', ip: '', lastSeen: new Date().getTime() };
  u.blocked = !!blocked;
  userPut_(dev, u);
}

/* ── Edit log: who changed what ───────────────────────────────────────────────
   One property per entry, numbered; only the newest LOG_MAX are kept. */
var LOG_MAX = 300;

function logWrite_(by, type, key, value) {
  try {
    var p = props_(), n = Number(p.getProperty(P_LOGN) || 0) + 1;
    p.setProperty(P_LOG + n, JSON.stringify([new Date().getTime(), String(by || '—'), String(type || ''), String(key || ''),
      (value === '' || value === null || value === undefined) ? '(cleared)' : String(value)]));
    p.setProperty(P_LOGN, String(n));
    if (n > LOG_MAX) p.deleteProperty(P_LOG + (n - LOG_MAX));   // drop the oldest
  } catch (e) {}                                          // logging must never break an edit
}

/** Most recent entries, newest first — for the admin panel. */
function logRead_(limit) {
  var all = props_().getProperties(), n = Number(all[P_LOGN] || 0), out = [];
  for (var i = n; i > 0 && out.length < (limit || 100); i--) {
    var raw = all[P_LOG + i]; if (!raw) continue;
    var r = null; try { r = JSON.parse(raw); } catch (e) {}
    if (r) out.push({ when: r[0], who: String(r[1] || ''), type: String(r[2] || ''), key: String(r[3] || ''), value: String(r[4] == null ? '' : r[4]) });
  }
  return out;
}

/** JSONP when a callback is given (the dashboard uses JSONP to avoid CORS), else plain JSON. */
function reply_(p, payload) {
  var json = JSON.stringify(payload);
  if (p.callback) {
    return ContentService.createTextOutput(p.callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var p = (e && e.parameter) ? e.parameter : {};
  var payload;
  try {
    var action = String(p.action || 'get');
    if (action === 'ping') {                              // heartbeat only — never reads the stored state
      var pr = ping_(String(p.who || ''), String(p.name || ''), String(p.ip || ''));
      if (String(p.admin || '') === '1') adminRefresh_(String(p.who || ''), String(p.name || ''));
      return reply_(p, { ok: true, online: pr.online, who: pr.who });
    }
    if (action === 'adminclaim') {                        // request the single admin seat
      return reply_(p, adminClaim_(String(p.who || ''), String(p.name || '')));
    }
    if (action === 'adminrelease') {                      // give up the admin seat
      adminRelease_(String(p.who || ''));
      return reply_(p, { ok: true });
    }
    if (action === 'whoami') {                            // client asks by device: my remembered name + am I blocked
      var u = userLookup_(String(p.dev || ''));
      return reply_(p, { ok: true, name: u ? u.name : '', blocked: u ? u.blocked : false });
    }
    if (action === 'register') {                          // user typed their name -> remember it against their device
      var lkR = LockService.getScriptLock(); try { lkR.waitLock(10000); } catch (e1) {}
      try { userUpsert_(String(p.dev || ''), String(p.name || ''), String(p.ip || '')); } finally { try { lkR.releaseLock(); } catch (e2) {} }
      var ur = userLookup_(String(p.dev || ''));
      return reply_(p, { ok: true, blocked: ur ? ur.blocked : false });
    }
    if (action === 'users') {                             // admin panel: every known visitor
      return reply_(p, { ok: true, users: usersAll_() });
    }
    if (action === 'block' || action === 'unblock') {     // admin: block / unblock a device
      var lkB = LockService.getScriptLock(); try { lkB.waitLock(10000); } catch (e3) {}
      try { userSetBlocked_(String(p.dev || ''), action === 'block'); } finally { try { lkB.releaseLock(); } catch (e4) {} }
      logWrite_(p.by, action === 'block' ? 'BLOCK device' : 'UNBLOCK device', String(p.name || p.dev || ''), '');
      return reply_(p, { ok: true });
    }
    if (action === 'log') {                               // admin panel: recent edits
      return reply_(p, { ok: true, log: logRead_(Number(p.limit || 100)) });
    }
    if (action === 'set' || action === 'clear') {
      var lock = LockService.getScriptLock();
      lock.waitLock(20000);                               // serialise concurrent devices
      try {
        if (action === 'set') writeOne_(String(p.type || ''), String(p.key || ''), p.value === undefined ? '' : p.value);
        else clearType_(String(p.type || ''));
        logWrite_(p.by, action === 'clear' ? ('clear:' + String(p.type || '')) : String(p.type || ''),
                  action === 'clear' ? '(all)' : String(p.key || ''),
                  action === 'clear' ? '' : p.value);
      } finally {
        lock.releaseLock();
      }
    }
    payload = { ok: true, state: readAll_() };
  } catch (err) {
    payload = { ok: false, error: String(err) };
  }
  return reply_(p, payload);
}
