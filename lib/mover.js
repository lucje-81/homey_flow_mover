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

/** App id of a device ("homey:app:com.growatt:sph" → "com.growatt"); null for Homey's own drivers. */
function deviceApp(d) {
  const m = /homey:app:([^:]+)/.exec(d.driverId || d.driverUri || d.ownerUri || '');
  return m ? m[1] : null;
}

/** Homey's own device types (groups, Matter, …): "homey:virtualdrivergroup:driver" → "group". */
function systemDriver(d) {
  const id = d.driverId || d.driverUri || '';
  if (/^homey:app:/.test(id)) return null;
  const m = /^homey:(?:virtualdriver)?([a-z0-9]+)/i.exec(id);
  return m ? m[1].toLowerCase() : (id || null);
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
 * How well the current values of two devices agree: +1 per equal value, +2 for an equal non-trivial
 * number (e.g. a temperature or energy total), -1 per different value. Capabilities on one side only don't count.
 */
function valueScore(a, b) {
  if (!a || !b) return 0;
  let score = 0;
  for (const [cap, va] of Object.entries(a)) {
    if (!(cap in b)) continue;
    const vb = b[cap];
    if (typeof va === 'number' && typeof vb === 'number') {
      const equal = Math.abs(va - vb) <= Math.max(0.011, Math.abs(va) * 0.002);
      if (equal) score += (va !== 0 && va !== 1 && va !== 100) ? 2 : 1; else score -= 1;
    } else if (va === vb) score += 1; else score -= 1;
  }
  return score;
}

/**
 * Match source devices to target devices, one to one.
 * 1. a target device that refers to the source device id (Homey Link keeps the id of the original device)
 * 2. same name and same zone path (e.g. "Gelijkvloers / Badkamer")
 * 3. same name, several candidates: the clearly best match of the current values
 * 4. same name, if that is the only free candidate (preferring the same app)
 * Anything else stays unmatched ("ambiguous" when there are several candidates) for the user to choose.
 * overrides: { srcId: dstId | '' } chosen by the user ('' = no device).
 */
function matchDevices(src, dst, srcZones, dstZones, overrides = {}) {
  const path = (zones, id) => zonePath(zones, id).map(norm).join('/');
  const result = {};
  const taken = new Set(Object.values(overrides).filter(Boolean).map((x) => String(x).toLowerCase()));
  const free = (d) => !taken.has(String(d.id).toLowerCase());
  const assign = (s, t, how) => {
    result[s.id] = { target: t.id, how, otherApp: deviceApp(t) !== deviceApp(s) };
    taken.add(String(t.id).toLowerCase());
  };
  const todo = [];
  for (const s of src) {
    if (Object.prototype.hasOwnProperty.call(overrides, s.id)) result[s.id] = { target: overrides[s.id] || null, how: 'manual' };
    else todo.push(s);
  }
  // 1. reference to the original device (Homey Link)
  const byRef = {};
  for (const d of dst) for (const r of d.refs || []) byRef[r] = byRef[r] || d;
  for (const s of todo) {
    const t = byRef[String(s.id).toLowerCase()];
    if (t && free(t)) assign(s, t, 'link');
  }
  // 2. name + zone path
  for (const s of todo) {
    if (result[s.id]) continue;
    const cands = dst.filter((d) => free(d) && norm(d.name) === norm(s.name) && path(dstZones, d.zone) === path(srcZones, s.zone));
    const sameName = src.filter((x) => !result[x.id] && norm(x.name) === norm(s.name) && path(srcZones, x.zone) === path(srcZones, s.zone));
    if (cands.length === 1 && sameName.length === 1) assign(s, cands[0], 'zone');
  }
  // 3. same name, several candidates: compare the current values (a Homey Link device mirrors the original)
  const groups = {};
  for (const s of todo) {
    if (result[s.id]) continue;
    (groups[norm(s.name)] = groups[norm(s.name)] || []).push(s);
  }
  for (const [name, srcs] of Object.entries(groups)) {
    const dsts = dst.filter((d) => free(d) && norm(d.name) === name);
    if (srcs.length < 1 || dsts.length < 2 && srcs.length < 2) continue;
    const pairs = [];
    for (const s of srcs) for (const d of dsts) pairs.push({ s, d, score: valueScore(s.values, d.values) });
    // Assign the clearly best pairs: best for both sides and clearly better than the runner-up
    pairs.sort((a, b) => b.score - a.score);
    for (const p of pairs) {
      if (result[p.s.id] || !free(p.d) || p.score <= 0) continue;
      const rivalS = pairs.filter((q) => q.s === p.s && q.d !== p.d && free(q.d)).reduce((m, q) => Math.max(m, q.score), -Infinity);
      const rivalD = pairs.filter((q) => q.d === p.d && q.s !== p.s && !result[q.s.id]).reduce((m, q) => Math.max(m, q.score), -Infinity);
      if (p.score > rivalS + 0.5 && p.score > rivalD + 0.5) assign(p.s, p.d, 'values');
    }
  }
  // 4. name alone, only when unambiguous on both sides
  for (const s of todo) {
    if (result[s.id]) continue;
    let cands = dst.filter((d) => free(d) && norm(d.name) === norm(s.name));
    if (cands.length > 1) {
      const sameApp = cands.filter((d) => deviceApp(d) === deviceApp(s));
      if (sameApp.length) cands = sameApp;
    }
    const rivals = src.filter((x) => x !== s && !result[x.id] && norm(x.name) === norm(s.name));
    if (cands.length === 1 && !rivals.length) assign(s, cands[0], 'name');
  }
  for (const s of todo) {
    if (result[s.id]) continue;
    const cands = dst.filter((d) => norm(d.name) === norm(s.name));
    result[s.id] = { target: null, how: cands.length ? 'ambiguous' : 'missing', candidates: cands.map((c) => c.id) };
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

/** Names from below the root zone down to this zone, e.g. ["Gelijkvloers", "Keuken"]; [] for the root. */
function zonePath(zones, id) {
  const parts = [];
  let cur = zones[String(id || '').toLowerCase()];
  let guard = 0;
  while (cur && cur.parent && guard++ < 20) {
    parts.unshift(cur.name);
    cur = zones[String(cur.parent).toLowerCase()];
  }
  return parts;
}

function rootZone(zones) {
  return Object.values(zones).find((z) => !z.parent) || null;
}

/** Map source zones to target zones by their path of names (the two root zones always match). */
function matchZones(srcZones, dstZones) {
  const byPath = {};
  for (const z of Object.values(dstZones)) byPath[zonePath(dstZones, z.id).map(norm).join('/')] = z.id;
  const out = {};
  for (const z of Object.values(srcZones)) {
    const t = byPath[zonePath(srcZones, z.id).map(norm).join('/')];
    if (t) out[String(z.id).toLowerCase()] = t;
  }
  return out;
}

/** Compare versions "1.10.2" vs "1.9.0": -1, 0 or 1 (non-numeric parts are ignored). */
function compareVersions(a, b) {
  const pa = String(a || '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
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
      // Zone cards (all lights off, …) exist as soon as the zone exists; a missing zone is reported already
      if (/^homey:zone:/.test(c.fullId)) continue;
      if (/^homey:app:/.test(mapped) && issues.some((i) => i.kind === 'app' && mapped.startsWith(`homey:app:${i.id}:`))) continue;
      if (ctx.dstCards.has(mapped)) continue;
      // Device cards: only judge when this Homey lists cards of that device at all (the list may leave out
      // the standard capability cards like on/off); otherwise we can't tell, so don't report it
      const dev = (/^homey:device:([0-9a-f-]{36}):/i.exec(mapped) || [])[1];
      if (dev) {
        if (!ctx.dstCardDevices) {
          ctx.dstCardDevices = new Set();
          for (const k of ctx.dstCards) { const m = /^homey:device:([0-9a-f-]{36}):/i.exec(k); if (m) ctx.dstCardDevices.add(m[1].toLowerCase()); }
        }
        if (!ctx.dstCardDevices.has(dev.toLowerCase())) continue;
        // Standard capability cards always exist when the device has the capability
        if (/:(on|off|toggle|onoff|dim|is_on|turned_on|turned_off|dim_changed|measure_[a-z_.]+_changed|meter_[a-z_.]+_changed)$/i.test(mapped)) continue;
      }
      issues.push({ kind: 'card', id: mapped, name: mapped, type: c.type });
    }
  }
  // Triggers that only exist on the other Homey (e.g. a button via Homey Link): can be bridged
  let bridge = null;
  const missingTriggers = issues.filter((i) => i.kind === 'card' && i.type === 'trigger');
  if (missingTriggers.length) {
    const plan = bridgePlan(flow, kind, missingTriggers.map((i) => i.id), ctx.idMap);
    if (plan.ok) {
      bridge = plan;
      for (const m of missingTriggers) issues.splice(issues.indexOf(m), 1);
      notes.push({ kind: 'bridge', id: plan.triggerId, name: plan.triggerId.split(':').pop() });
    } else {
      notes.push({ kind: 'noBridge', id: plan.reason, name: plan.reason });
    }
  }
  return {
    id: flow.id,
    kind,
    name: flow.name,
    bridge,
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

/**
 * Can the missing trigger stay on the other Homey and start this flow there ("bridge")?
 * Only one missing trigger, and its tokens may not be used further in the flow.
 */
function bridgePlan(flow, kind, missingIds, idMap) {
  if (missingIds.length !== 1) return { ok: false, reason: 'several' };
  if (kind === 'advanced') {
    const entry = Object.entries(flow.cards || {}).find(([, c]) => c.type === 'trigger' && rewrite(fullCardId(c), idMap) === missingIds[0]);
    if (!entry) return { ok: false, reason: 'notFound' };
    const [key, card] = entry;
    const others = Object.entries(flow.cards).filter(([k]) => k !== key).map(([, c]) => c.args || {});
    if (JSON.stringify(others).includes(key)) return { ok: false, reason: 'tokens' };
    return { ok: true, cardKey: key, trigger: card, triggerId: missingIds[0] };
  }
  const rest = JSON.stringify([flow.conditions || [], flow.actions || []]);
  if (/\[\[trigger|\|trigger/.test(rest)) return { ok: false, reason: 'tokens' };
  return { ok: true, cardKey: null, trigger: flow.trigger, triggerId: missingIds[0] };
}

function fullCardId(c) {
  if (!c || !c.id) return null;
  if (/^homey:[^:]+:/.test(c.id) && c.id.split(':').length >= 4) return c.id;
  const owner = c.ownerUri || c.uri;
  return owner ? `${owner}:${c.id}` : c.id;
}

const STARTED = 'homey:manager:flow:programmatic_trigger';

/** Flow body for this Homey with the bridged trigger replaced by "This flow is started". */
function bridgedBody(flow, kind, bridge, idMap, folder, enabled) {
  if (kind === 'advanced') {
    const cards = rewrite(plain(flow.cards || {}), idMap);
    const old = cards[bridge.cardKey];
    cards[bridge.cardKey] = { id: STARTED, type: 'trigger', args: {}, x: old.x, y: old.y, outputSuccess: old.outputSuccess || [] };
    return { name: flow.name, folder: folder || undefined, enabled, cards };
  }
  const body = flowBody(flow, kind, idMap, folder, enabled);
  body.trigger = { id: STARTED, args: {} };
  return body;
}

/** Standard flow for the other Homey: the original trigger, then "start flow on <this Homey>" (Homey Link). */
function bridgeFlowBody(flow, bridge, linkHomey, target, folder, enabled, namePrefix) {
  const t = plain(bridge.trigger);
  const trigger = { id: fullCardId(t), args: t.args || {} };
  if (t.droptoken) trigger.droptoken = t.droptoken;
  return {
    name: `${namePrefix}${flow.name}`,
    folder: folder || undefined,
    enabled,
    trigger,
    conditions: [],
    actions: [{
      id: 'homey:app:com.athom.link:start_flow',
      group: 'then',
      args: {
        homey: linkHomey,
        flow: { id: target.id, type: target.kind === 'advanced' ? 'advanced' : 'standard', title: flow.name, name: flow.name },
      },
    }],
  };
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
  UUID_RE, valueScore, plain, norm, deviceApp, systemDriver, collectUuids, collectApps, rewrite, matchDevices, matchByName,
  compareVersions, folderPath, zonePath, rootZone, matchZones, flowCards, cardIdSet, analyseFlow, flowBody, normaliseCard, normaliseFlow,
  bridgePlan, bridgedBody, bridgeFlowBody, fullCardId,
};
