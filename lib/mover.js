'use strict';

/*
 * Pure helpers for moving flows from one Homey to another:
 * matching devices/variables/zones/users by name, analysing flows and rewriting their ids.
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const APP_RE = /homey:app:([a-z0-9._-]+)/gi;

/** Plain JSON copy without homey-api internals (keys starting with "__"). */
function plain(value) {
  return JSON.parse(JSON.stringify(value, (key, v) => (key.startsWith('__') ? undefined : v)));
}

function norm(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** App id of a device ("homey:app:com.growatt:sph" → "com.growatt"). */
function deviceApp(d) {
  const m = /homey:app:([^:]+)/.exec(d.driverId || d.driverUri || d.ownerUri || '');
  return m ? m[1] : (d.driverId || d.driverUri || '');
}

/** Walk any JSON value and call fn on every string. */
function walkStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => walkStrings(v, fn));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = walkStrings(v, fn);
    return out;
  }
  return value;
}

/** Every uuid that appears in a string value. */
function collectUuids(value) {
  const found = new Set();
  walkStrings(value, (s) => {
    const m = s.match(UUID_RE);
    if (m) m.forEach((u) => found.add(u.toLowerCase()));
    return s;
  });
  return found;
}

function collectApps(value) {
  const found = new Set();
  walkStrings(value, (s) => {
    let m;
    APP_RE.lastIndex = 0;
    while ((m = APP_RE.exec(s))) found.add(m[1]);
    return s;
  });
  return found;
}

/** Replace every mapped uuid in all string values. */
function rewrite(value, idMap) {
  return walkStrings(value, (s) => s.replace(UUID_RE, (u) => idMap[u.toLowerCase()] || u));
}

/**
 * Match source devices to target devices.
 * overrides: { srcId: dstId | '' } chosen by the user ('' = no device).
 */
function matchDevices(src, dst, srcZones, dstZones, overrides = {}) {
  const zoneName = (zones, id) => norm(zones[id] && zones[id].name);
  const result = {};
  for (const s of src) {
    if (Object.prototype.hasOwnProperty.call(overrides, s.id)) {
      result[s.id] = { target: overrides[s.id] || null, how: 'manual' };
      continue;
    }
    let cands = dst.filter((d) => norm(d.name) === norm(s.name));
    if (cands.length > 1) {
      const sameApp = cands.filter((d) => deviceApp(d) === deviceApp(s));
      if (sameApp.length) cands = sameApp;
    }
    if (cands.length > 1) {
      const sameZone = cands.filter((d) => zoneName(dstZones, d.zone) === zoneName(srcZones, s.zone));
      if (sameZone.length) cands = sameZone;
    }
    if (cands.length === 1) {
      const t = cands[0];
      result[s.id] = { target: t.id, how: 'auto', otherApp: deviceApp(t) !== deviceApp(s) };
    } else {
      result[s.id] = { target: null, how: cands.length ? 'ambiguous' : 'missing', candidates: cands.map((c) => c.id) };
    }
  }
  return result;
}

function matchByName(src, dst, sameType) {
  const out = {};
  for (const s of src) {
    const t = dst.find((d) => norm(d.name) === norm(s.name) && (!sameType || d.type === s.type));
    if (t) out[s.id] = t.id;
  }
  return out;
}

/** Folder path "A / B" of a folder id. */
function folderPath(folders, id) {
  const parts = [];
  let cur = folders[id];
  let guard = 0;
  while (cur && guard++ < 20) {
    parts.unshift(cur.name);
    cur = cur.parent ? folders[cur.parent] : null;
  }
  return parts.join(' / ');
}

/** All flow cards of a flow as [{ fullId, type }]. */
function flowCards(flow, kind) {
  const out = [];
  const full = (c) => {
    if (!c || !c.id) return null;
    if (/^homey:[^:]+:/.test(c.id) && c.id.split(':').length >= 4) return c.id;
    const owner = c.ownerUri || c.uri;
    return owner ? `${owner}:${c.id}` : c.id;
  };
  if (kind === 'advanced') {
    for (const c of Object.values(flow.cards || {})) {
      if (['trigger', 'condition', 'action'].includes(c.type)) out.push({ fullId: full(c), type: c.type });
    }
  } else {
    if (flow.trigger) out.push({ fullId: full(flow.trigger), type: 'trigger' });
    (flow.conditions || []).forEach((c) => out.push({ fullId: full(c), type: 'condition' }));
    (flow.actions || []).forEach((c) => out.push({ fullId: full(c), type: 'action' }));
  }
  return out.filter((c) => c.fullId);
}

/** Set of card ids available on a Homey, from getFlowCardTriggers/Conditions/Actions results. */
function cardIdSet(...lists) {
  const set = new Set();
  for (const list of lists) {
    for (const [key, c] of Object.entries(list || {})) {
      set.add(key);
      if (c && c.id) {
        set.add(c.id);
        if (c.ownerUri) set.add(`${c.ownerUri}:${c.id}`);
        if (c.uri) set.add(`${c.uri}:${c.id}`);
      }
    }
  }
  return set;
}

/**
 * Analyse one source flow against the target.
 * ctx: { src, dst, deviceMatch, varMap, zoneMap, userMap, dstCards (Set|null), dstApps (Set|null), dstFlowNames (Set) }
 */
function analyseFlow(flow, kind, ctx) {
  const uuids = collectUuids(kind === 'advanced' ? flow.cards : [flow.trigger, flow.conditions, flow.actions]);
  const issues = [];
  const notes = [];
  const devices = [];
  const variables = [];
  for (const u of uuids) {
    if (ctx.src.devices[u]) {
      const m = ctx.deviceMatch[u];
      devices.push(u);
      if (!m || !m.target) issues.push({ kind: 'device', id: u, name: ctx.src.devices[u].name });
      else if (m.otherApp) notes.push({ kind: 'otherApp', id: u, name: ctx.src.devices[u].name });
    } else if (ctx.src.variables[u]) {
      variables.push(u);
      if (!ctx.varMap[u]) notes.push({ kind: 'variable', id: u, name: ctx.src.variables[u].name });
    } else if (ctx.src.zones[u]) {
      if (!ctx.zoneMap[u]) issues.push({ kind: 'zone', id: u, name: ctx.src.zones[u].name });
    } else if (ctx.src.users[u]) {
      if (!ctx.userMap[u]) issues.push({ kind: 'user', id: u, name: ctx.src.users[u].name });
    } else if (ctx.src.flowsById[u] && u !== flow.id) {
      if (!ctx.flowNameMap[u] && !ctx.selectedIds.has(u)) notes.push({ kind: 'flowRef', id: u, name: ctx.src.flowsById[u].name });
    }
  }
  if (ctx.dstApps) {
    for (const app of collectApps(kind === 'advanced' ? flow.cards : [flow.trigger, flow.conditions, flow.actions])) {
      if (!ctx.dstApps.has(app)) issues.push({ kind: 'app', id: app, name: app });
    }
  }
  // Does every card exist on the target (after the device ids are replaced)?
  if (ctx.dstCards && ctx.dstCards.size) {
    const idMap = ctx.idMap;
    for (const c of flowCards(flow, kind)) {
      const mapped = rewrite(c.fullId, idMap);
      const devId = (/^homey:device:([0-9a-f-]{36})/i.exec(c.fullId) || [])[1];
      if (devId && issues.some((i) => i.kind === 'device' && i.id === devId.toLowerCase())) continue;
      if (/^homey:app:/.test(mapped) && issues.some((i) => i.kind === 'app' && mapped.startsWith(`homey:app:${i.id}:`))) continue;
      if (!ctx.dstCards.has(mapped)) issues.push({ kind: 'card', id: mapped, name: mapped.split(':').pop(), type: c.type });
    }
  }
  return {
    id: flow.id,
    kind,
    name: flow.name,
    folder: flow.folder || null,
    folderPath: folderPath(ctx.src.folders, flow.folder),
    enabled: flow.enabled !== false,
    exists: ctx.dstFlowNames.has(norm(flow.name)),
    devices,
    variables,
    issues,
    notes,
  };
}

/**
 * Cards can carry an outdated device id in "id" while "ownerUri" points to the current device
 * (Homey uses ownerUri). Make "id" match ownerUri so the card is mapped to the right device.
 */
function normaliseCard(c) {
  if (!c || typeof c.id !== 'string' || typeof c.ownerUri !== 'string') return c;
  const owner = /^homey:device:([0-9a-f-]{36})$/i.exec(c.ownerUri);
  const inId = /^homey:device:([0-9a-f-]{36}):(.+)$/i.exec(c.id);
  if (owner && inId && owner[1].toLowerCase() !== inId[1].toLowerCase()) {
    return { ...c, id: `homey:device:${owner[1]}:${inId[2]}` };
  }
  return c;
}

function normaliseFlow(flow, kind) {
  if (kind === 'advanced') {
    const cards = {};
    for (const [k, c] of Object.entries(flow.cards || {})) cards[k] = normaliseCard(c);
    return { ...flow, cards };
  }
  return { ...flow, trigger: normaliseCard(flow.trigger), conditions: (flow.conditions || []).map(normaliseCard), actions: (flow.actions || []).map(normaliseCard) };
}

/** Body for createFlow / createAdvancedFlow. */
function flowBody(flow, kind, idMap, folder, enabled) {
  if (kind === 'advanced') {
    return { name: flow.name, folder: folder || undefined, enabled, cards: rewrite(plain(flow.cards || {}), idMap) };
  }
  const card = (c) => {
    const copy = rewrite(plain(c), idMap);
    delete copy.broken;
    return copy;
  };
  return {
    name: flow.name,
    folder: folder || undefined,
    enabled,
    trigger: card(flow.trigger),
    conditions: (flow.conditions || []).map(card),
    actions: (flow.actions || []).map(card),
  };
}

module.exports = {
  UUID_RE, plain, norm, deviceApp, collectUuids, collectApps, rewrite, matchDevices, matchByName,
  folderPath, flowCards, cardIdSet, analyseFlow, flowBody, normaliseCard, normaliseFlow,
};
