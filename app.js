'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const M = require('./lib/mover');

const CACHE_MS = 60 * 1000;

class FlowMoverApp extends Homey.App {

  async onInit() {
    this.target = await HomeyAPI.createAppAPI({ homey: this.homey });
    this.cache = {};
    this.log('Flow Mover ready');
  }

  // ---------------------------------------------------------------- connection

  normaliseAddress(address) {
    let a = String(address || '').trim().replace(/\/+$/, '');
    if (!a) return '';
    if (!/^https?:\/\//i.test(a)) a = `http://${a}`;
    return a;
  }

  async getSource(force) {
    const address = this.normaliseAddress(this.homey.settings.get('address'));
    const token = String(this.homey.settings.get('token') || '').trim();
    if (!address || !token) throw new Error(this.homey.__('errors.notConnected'));
    const key = `${address}|${token}`;
    if (!this.source || this.sourceKey !== key || force) {
      this.source = await HomeyAPI.createLocalAPI({ address, token });
      this.sourceKey = key;
      this.cache = {};
    }
    return this.source;
  }

  /** Save address + token and test them by reading the flows of the source Homey. */
  async connect({ address, token }) {
    const a = this.normaliseAddress(address);
    if (!a) throw new Error(this.homey.__('errors.noAddress'));
    this.homey.settings.set('address', a);
    if (token) this.homey.settings.set('token', String(token).trim());
    this.cache = {};
    const src = await this.getSource(true);
    const [flows, advanced, devices] = await Promise.all([
      src.flow.getFlows(), src.flow.getAdvancedFlows(), src.devices.getDevices(),
    ]);
    return {
      address: a,
      flows: Object.keys(flows).length,
      advancedFlows: Object.keys(advanced).length,
      devices: Object.keys(devices).length,
    };
  }

  async status() {
    return {
      address: this.homey.settings.get('address') || '',
      hasToken: !!this.homey.settings.get('token'),
      language: this.homey.i18n.getLanguage(),
    };
  }

  // ---------------------------------------------------------------- data

  async load(api, side, withCards) {
    const cached = this.cache[side];
    if (cached && Date.now() - cached.time < CACHE_MS && (!withCards || cached.data.cards)) return cached.data;
    const safe = (p, fallback = {}) => p.catch((err) => { this.error(`${side}:`, err.message); return fallback; });
    const [devices, zones, flows, advanced, folders, variables, users, apps, triggers, conditions, actions] = await Promise.all([
      api.devices.getDevices(),
      safe(api.zones.getZones()),
      api.flow.getFlows(),
      api.flow.getAdvancedFlows(),
      safe(api.flow.getFlowFolders()),
      safe(api.logic.getVariables()),
      safe(api.users.getUsers()),
      safe(api.apps.getApps(), null),
      withCards ? safe(api.flow.getFlowCardTriggers(), null) : null,
      withCards ? safe(api.flow.getFlowCardConditions(), null) : null,
      withCards ? safe(api.flow.getFlowCardActions(), null) : null,
    ]);
    const byId = (obj, pick) => Object.fromEntries(Object.values(obj || {}).map((x) => [String(x.id).toLowerCase(), pick(x)]));
    const data = {
      devices: byId(devices, (d) => ({ id: String(d.id).toLowerCase(), name: d.name, zone: d.zone, driverId: d.driverId || d.driverUri, ownerUri: d.ownerUri })),
      zones: byId(zones, (z) => ({ id: z.id, name: z.name, parent: z.parent })),
      folders: byId(folders, (f) => ({ id: f.id, name: f.name, parent: f.parent || null })),
      variables: byId(variables, (v) => ({ id: v.id, name: v.name, type: v.type, value: v.value })),
      users: byId(users, (u) => ({ id: u.id, name: u.name })),
      flows: Object.values(flows).map((f) => M.normaliseFlow(M.plain(f), 'flow')),
      advanced: Object.values(advanced).map((f) => M.normaliseFlow(M.plain(f), 'advanced')),
      apps: apps ? new Set(Object.keys(apps)) : null,
      cards: withCards && (triggers || conditions || actions) ? M.cardIdSet(triggers, conditions, actions) : null,
    };
    data.flowsById = {};
    data.flows.forEach((f) => { data.flowsById[String(f.id).toLowerCase()] = { name: f.name, kind: 'flow' }; });
    data.advanced.forEach((f) => { data.flowsById[String(f.id).toLowerCase()] = { name: f.name, kind: 'advanced' }; });
    this.cache[side] = { time: Date.now(), data };
    return data;
  }

  /** Everything needed to map ids from source to target. */
  async context(selected = []) {
    const src = await this.load(await this.getSource(), 'source', false);
    const dst = await this.load(this.target, 'target', true);
    const overrides = this.homey.settings.get('deviceMap') || {};
    const deviceMatch = M.matchDevices(Object.values(src.devices), Object.values(dst.devices), src.zones, dst.zones, overrides);
    const varMap = M.matchByName(Object.values(src.variables), Object.values(dst.variables), true);
    const zoneMap = M.matchByName(Object.values(src.zones), Object.values(dst.zones));
    const userMap = M.matchByName(Object.values(src.users), Object.values(dst.users));
    const dstFlowNames = new Set([...dst.flows, ...dst.advanced].map((f) => M.norm(f.name)));
    // Source flows that already exist on the target (same name and kind) → for "start flow" cards
    const flowNameMap = {};
    for (const [kind, list, dlist] of [['flow', src.flows, dst.flows], ['advanced', src.advanced, dst.advanced]]) {
      for (const f of list) {
        const t = dlist.find((d) => M.norm(d.name) === M.norm(f.name));
        if (t) flowNameMap[String(f.id).toLowerCase()] = t.id;
      }
    }
    const idMap = {};
    for (const [id, m] of Object.entries(deviceMatch)) if (m.target) idMap[id] = m.target;
    Object.assign(idMap, varMap, zoneMap, userMap, flowNameMap);
    return {
      src, dst, deviceMatch, varMap, zoneMap, userMap, flowNameMap, idMap, dstFlowNames,
      dstCards: dst.cards, dstApps: dst.apps, selectedIds: new Set(selected.map((s) => String(s).toLowerCase())),
    };
  }

  /** Analysis for the settings page: flows with their problems, and the devices they use. */
  async analyse() {
    const ctx = await this.context();
    const flows = [
      ...ctx.src.flows.map((f) => M.analyseFlow(f, 'flow', ctx)),
      ...ctx.src.advanced.map((f) => M.analyseFlow(f, 'advanced', ctx)),
    ].sort((a, b) => (a.folderPath + a.name).localeCompare(b.folderPath + b.name));
    const used = new Set();
    flows.forEach((f) => f.devices.forEach((d) => used.add(d)));
    const zoneName = (zones, id) => (zones[id] && zones[id].name) || '';
    const devices = [...used].map((id) => {
      const s = ctx.src.devices[id];
      const m = ctx.deviceMatch[id] || {};
      return {
        id, name: s.name, zone: zoneName(ctx.src.zones, s.zone), app: M.deviceApp(s),
        target: m.target || null, how: m.how, otherApp: !!m.otherApp,
        flows: flows.filter((f) => f.devices.includes(id)).length,
      };
    }).sort((a, b) => (a.target ? 1 : 0) - (b.target ? 1 : 0) || a.name.localeCompare(b.name));
    const targets = Object.values(ctx.dst.devices)
      .map((d) => ({ id: d.id, name: d.name, zone: zoneName(ctx.dst.zones, d.zone), app: M.deviceApp(d) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { flows, devices, targets, cardsChecked: !!(ctx.dstCards && ctx.dstCards.size) };
  }

  async setDeviceMap({ srcId, dstId }) {
    const map = { ...(this.homey.settings.get('deviceMap') || {}) };
    if (dstId === undefined) delete map[srcId];
    else map[srcId] = dstId || '';
    this.homey.settings.set('deviceMap', map);
    return true;
  }

  async resetDeviceMap() {
    this.homey.settings.unset('deviceMap');
    return true;
  }

  // ---------------------------------------------------------------- migrate

  /** Create (nested) folders on the target with the same names; returns target folder id. */
  async ensureFolder(srcFolderId, ctx, created) {
    if (!srcFolderId) return null;
    const key = String(srcFolderId).toLowerCase();
    if (created[key]) return created[key];
    const f = ctx.src.folders[key];
    if (!f) return null;
    const parent = f.parent ? await this.ensureFolder(f.parent, ctx, created) : null;
    let t = Object.values(ctx.dst.folders).find((d) => M.norm(d.name) === M.norm(f.name) && (d.parent || null) === (parent || null));
    if (!t) {
      t = await this.target.flow.createFlowFolder({ flowfolder: parent ? { name: f.name, parent } : { name: f.name } });
      ctx.dst.folders[String(t.id).toLowerCase()] = { id: t.id, name: t.name, parent: parent || null };
    }
    created[key] = t.id;
    return t.id;
  }

  async migrate({ ids, keepEnabled = false, createVariables = true, skipExisting = true }) {
    this.cache = {};
    const ctx = await this.context(ids || []);
    const wanted = new Set((ids || []).map((x) => String(x).toLowerCase()));
    const all = [
      ...ctx.src.flows.map((f) => ({ flow: f, kind: 'flow' })),
      ...ctx.src.advanced.map((f) => ({ flow: f, kind: 'advanced' })),
    ].filter((x) => wanted.has(String(x.flow.id).toLowerCase()));
    const results = [];
    const folders = {};

    // Missing variables (same name and type, with the current value)
    if (createVariables) {
      const needed = new Set();
      for (const { flow, kind } of all) {
        for (const u of M.collectUuids(kind === 'advanced' ? flow.cards : [flow.trigger, flow.conditions, flow.actions])) {
          if (ctx.src.variables[u] && !ctx.varMap[u]) needed.add(u);
        }
      }
      for (const u of needed) {
        const v = ctx.src.variables[u];
        try {
          const created = await this.target.logic.createVariable({ variable: { name: v.name, type: v.type, value: v.value } });
          ctx.varMap[u] = created.id;
          ctx.idMap[u] = created.id;
          results.push({ type: 'variable', name: v.name, ok: true });
        } catch (err) {
          results.push({ type: 'variable', name: v.name, ok: false, error: err.message });
        }
      }
    }

    const createdFlows = [];
    for (const { flow, kind } of all) {
      if (skipExisting && ctx.dstFlowNames.has(M.norm(flow.name))) {
        results.push({ type: kind, name: flow.name, ok: true, skipped: true });
        continue;
      }
      try {
        const folder = await this.ensureFolder(flow.folder, ctx, folders);
        const enabled = keepEnabled ? flow.enabled !== false : false;
        const body = M.flowBody(flow, kind, ctx.idMap, folder, enabled);
        const created = kind === 'advanced'
          ? await this.target.flow.createAdvancedFlow({ advancedflow: body })
          : await this.target.flow.createFlow({ flow: body });
        ctx.idMap[String(flow.id).toLowerCase()] = created.id;
        createdFlows.push({ flow, kind, created, folder, enabled });
        results.push({ type: kind, name: flow.name, ok: true, id: created.id });
      } catch (err) {
        results.push({ type: kind, name: flow.name, ok: false, error: err.message });
      }
    }

    // Second pass: "start flow" cards that point to flows created in this run
    const createdIds = new Set(createdFlows.map((x) => String(x.flow.id).toLowerCase()));
    for (const { flow, kind, created, folder, enabled } of createdFlows) {
      const refs = [...M.collectUuids(kind === 'advanced' ? flow.cards : [flow.trigger, flow.conditions, flow.actions])]
        .filter((u) => createdIds.has(u) && u !== String(flow.id).toLowerCase());
      if (!refs.length) continue;
      try {
        const body = M.flowBody(flow, kind, ctx.idMap, folder, enabled);
        if (kind === 'advanced') await this.target.flow.updateAdvancedFlow({ id: created.id, advancedflow: body });
        else await this.target.flow.updateFlow({ id: created.id, flow: body });
      } catch (err) {
        results.push({ type: kind, name: flow.name, ok: false, error: `${this.homey.__('errors.flowRefs')}: ${err.message}` });
      }
    }
    this.cache = {};
    return results;
  }

}

module.exports = FlowMoverApp;
