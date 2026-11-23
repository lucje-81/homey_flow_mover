'use strict';

const crypto = require('crypto');
const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const M = require('./lib/mover');

const CACHE_MS = 60 * 1000;
const WIDGET_APP = 'compact.widgets';
const WIDGET_SETTINGS = ['panels', 'icons', 'energyFields'];

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
    const [devices, zones, flows, advanced, folders, variables, users, apps, triggers, conditions, actions, dashboards] = await Promise.all([
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
      safe(api.dashboards.getDashboards(), {}),
    ]);
    const byId = (obj, pick) => Object.fromEntries(Object.values(obj || {}).map((x) => [String(x.id).toLowerCase(), pick(x)]));
    const data = {
      devices: byId(devices, (d) => ({ id: String(d.id).toLowerCase(), name: d.name, zone: d.zone, driverId: d.driverId || d.driverUri, ownerUri: d.ownerUri })),
      zones: byId(zones, (z) => ({ id: z.id, name: z.name, parent: z.parent || null, icon: z.icon || 'default' })),
      folders: byId(folders, (f) => ({ id: f.id, name: f.name, parent: f.parent || null })),
      variables: byId(variables, (v) => ({ id: v.id, name: v.name, type: v.type, value: v.value })),
      users: byId(users, (u) => ({ id: u.id, name: u.name })),
      flows: Object.values(flows).map((f) => M.normaliseFlow(M.plain(f), 'flow')),
      advanced: Object.values(advanced).map((f) => M.normaliseFlow(M.plain(f), 'advanced')),
      apps: apps ? new Set(Object.keys(apps)) : null,
      appInfo: Object.fromEntries(Object.values(apps || {}).map((a) => [a.id, { id: a.id, name: a.name, origin: a.origin, channel: a.channel, version: a.version }])),
      cards: withCards && (triggers || conditions || actions) ? M.cardIdSet(triggers, conditions, actions) : null,
      dashboards: Object.values(dashboards || {}).map((x) => M.plain(x)),
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
    const zoneMap = M.matchZones(src.zones, dst.zones);
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
    return {
      flows, devices, targets, cardsChecked: !!(ctx.dstCards && ctx.dstCards.size),
      missingApps: this.missingApps(ctx, flows), missingVariables: this.missingVariables(ctx), zones: this.zonePlan(ctx),
      dashboards: this.analyseDashboards(ctx),
      widgetApp: ctx.dstApps ? ctx.dstApps.has(WIDGET_APP) && !!(ctx.src.apps && ctx.src.apps.has(WIDGET_APP)) : false,
    };
  }

  /** Zones to create and matched devices that sit in another zone than on the other Homey. */
  zonePlan(ctx) {
    const show = (zones, id) => M.zonePath(zones, id).join(' / ') || ((M.rootZone(zones) || {}).name || '');
    const create = Object.values(ctx.src.zones)
      .filter((z) => z.parent && !ctx.zoneMap[String(z.id).toLowerCase()])
      .map((z) => ({ id: String(z.id).toLowerCase(), path: show(ctx.src.zones, z.id), depth: M.zonePath(ctx.src.zones, z.id).length }))
      .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
    const moves = [];
    for (const [srcId, m] of Object.entries(ctx.deviceMatch)) {
      if (!m.target) continue;
      const s = ctx.src.devices[srcId];
      const d = ctx.dst.devices[String(m.target).toLowerCase()];
      if (!s || !d) continue;
      const want = M.zonePath(ctx.src.zones, s.zone).map(M.norm).join('/');
      const have = M.zonePath(ctx.dst.zones, d.zone).map(M.norm).join('/');
      if (want === have) continue;
      moves.push({ id: d.id, srcId, name: d.name, from: show(ctx.dst.zones, d.zone), to: show(ctx.src.zones, s.zone) });
    }
    moves.sort((a, b) => a.to.localeCompare(b.to) || a.name.localeCompare(b.name));
    return { create, moves };
  }

  /** Create the missing zones (same names, icons and nesting) and move the chosen devices into their zone. */
  async applyZones({ deviceIds }) {
    this.cache = {};
    const ctx = await this.context();
    const results = [];
    const plan = this.zonePlan(ctx);
    const created = { ...ctx.zoneMap };
    const srcRoot = M.rootZone(ctx.src.zones);
    const dstRoot = M.rootZone(ctx.dst.zones);
    if (srcRoot && dstRoot) created[String(srcRoot.id).toLowerCase()] = dstRoot.id;
    const wanted = new Set((deviceIds || []).map((x) => String(x).toLowerCase()));
    const moves = plan.moves.filter((m) => wanted.has(String(m.id).toLowerCase()));
    // All zones of the other Homey that are missing here, parents first
    for (const c of plan.create) {
      const z = ctx.src.zones[c.id];
      const parent = created[String(z.parent).toLowerCase()];
      if (!parent) { results.push({ type: 'zone', name: c.path, ok: false, error: 'parent zone missing' }); continue; }
      try {
        const nz = await this.target.zones.createZone({ zone: { name: z.name, icon: z.icon || 'default', parent } });
        created[c.id] = nz.id;
        results.push({ type: 'zone', name: c.path, ok: true });
      } catch (err) {
        results.push({ type: 'zone', name: c.path, ok: false, error: err.message });
      }
    }
    for (const m of moves) {
      const zone = created[String(ctx.src.devices[m.srcId].zone).toLowerCase()];
      if (!zone) { results.push({ type: 'device', name: m.name, ok: false, error: m.to }); continue; }
      try {
        await this.target.devices.updateDevice({ id: m.id, device: { zone } });
        results.push({ type: 'device', name: m.name, ok: true, to: m.to });
      } catch (err) {
        results.push({ type: 'device', name: m.name, ok: false, error: err.message });
      }
    }
    this.cache = {};
    return results;
  }

  /** Dashboards of the other Homey with the devices and apps their widgets need. */
  analyseDashboards(ctx) {
    const names = new Set(ctx.dst.dashboards.map((d) => M.norm(d.name)));
    return ctx.src.dashboards.map((db) => {
      const widgets = (db.columns || []).reduce((n, c) => n + ((c.widgets || []).length), 0);
      const issues = [];
      for (const u of M.collectUuids(db.columns)) {
        if (ctx.src.devices[u] && !(ctx.deviceMatch[u] && ctx.deviceMatch[u].target)) issues.push({ kind: 'device', id: u, name: ctx.src.devices[u].name });
      }
      if (ctx.dstApps) {
        for (const app of M.collectApps(db.columns)) if (!ctx.dstApps.has(app)) issues.push({ kind: 'app', id: app, name: (ctx.src.appInfo[app] || {}).name || app });
      }
      return { id: db.id, name: db.name, widgets, exists: names.has(M.norm(db.name)), issues };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Create the chosen dashboards here, with all device/zone/flow ids rewritten. */
  async migrateDashboards({ ids, copyWidgetSettings }) {
    this.cache = {};
    const ctx = await this.context();
    const results = [];
    const wanted = new Set((ids || []).map((x) => String(x).toLowerCase()));
    if (copyWidgetSettings) results.push(...await this.copyWidgetSettings(ctx));
    for (const db of ctx.src.dashboards.filter((d) => wanted.has(String(d.id).toLowerCase()))) {
      let name = db.name;
      if (ctx.dst.dashboards.some((d) => M.norm(d.name) === M.norm(name))) name = `${name} (${this.homey.__('copy')})`;
      try {
        // New ids for columns and widgets, so a dashboard can be copied twice without clashes
        const columns = M.rewrite(M.plain(db.columns || []), ctx.idMap).map((col) => ({
          ...col, id: crypto.randomUUID(), widgets: (col.widgets || []).map((w) => ({ ...w, id: crypto.randomUUID() })),
        }));
        await this.target.dashboards.createDashboard({ dashboard: { name, columns } });
        results.push({ type: 'dashboard', name, ok: true });
      } catch (err) {
        results.push({ type: 'dashboard', name, ok: false, error: err.message });
      }
    }
    this.cache = {};
    return results;
  }

  /** Settings of the Compact Widgets app (gauge panels, icons, chosen values), with device ids rewritten. */
  async copyWidgetSettings(ctx) {
    const src = await this.getSource();
    let settings;
    try {
      settings = await src.apps.getAppSettings({ id: WIDGET_APP });
    } catch (err) {
      return [{ type: 'settings', name: 'Compact Widgets', ok: false, error: this.homey.__('errors.appSettings') }];
    }
    const out = [];
    for (const key of WIDGET_SETTINGS) {
      if (settings[key] === undefined || settings[key] === null) continue;
      // Keys of icons/energyFields are device ids: rewrite keys as well as values
      let value = M.rewrite(M.plain(settings[key]), ctx.idMap);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        value = Object.fromEntries(Object.entries(value).map(([k, v]) => [ctx.idMap[String(k).toLowerCase()] || k, v]));
      }
      try {
        await this.target.apps.setAppSetting({ id: WIDGET_APP, name: key, value });
        out.push({ type: 'settings', name: `Compact Widgets: ${key}`, ok: true });
      } catch (err) {
        out.push({ type: 'settings', name: `Compact Widgets: ${key}`, ok: false, error: err.message });
      }
    }
    return out;
  }

  /** Apps used by the flows (cards or devices) that are not installed on this Homey. */
  missingApps(ctx, flows) {
    if (!ctx.dstApps) return [];
    const used = {};
    const add = (appId, flowId, deviceId) => {
      if (!appId || ctx.dstApps.has(appId)) return;
      used[appId] = used[appId] || { flows: new Set(), devices: new Set() };
      if (flowId) used[appId].flows.add(flowId);
      if (deviceId) used[appId].devices.add(deviceId);
    };
    for (const [kind, list] of [['flow', ctx.src.flows], ['advanced', ctx.src.advanced]]) {
      for (const f of list) {
        const body = kind === 'advanced' ? f.cards : [f.trigger, f.conditions, f.actions];
        M.collectApps(body).forEach((a) => add(a, f.id));
        M.collectUuids(body).forEach((u) => {
          const d = ctx.src.devices[u];
          if (d && !(ctx.deviceMatch[u] && ctx.deviceMatch[u].target)) add(M.deviceApp(d), f.id, u);
        });
      }
    }
    return Object.entries(used).map(([id, u]) => {
      const info = ctx.src.appInfo[id] || {};
      return {
        id, name: info.name || id, origin: info.origin || null, channel: info.channel || 'live', version: info.version || '',
        flows: u.flows.size, devices: u.devices.size,
      };
    }).sort((a, b) => b.flows - a.flows || a.name.localeCompare(b.name));
  }

  /** Variables of the other Homey that don't exist here (same name and type). */
  missingVariables(ctx) {
    const usage = {};
    for (const [kind, list] of [['flow', ctx.src.flows], ['advanced', ctx.src.advanced]]) {
      for (const f of list) {
        M.collectUuids(kind === 'advanced' ? f.cards : [f.trigger, f.conditions, f.actions]).forEach((u) => {
          if (ctx.src.variables[u]) usage[u] = (usage[u] || 0) + 1;
        });
      }
    }
    return Object.values(ctx.src.variables)
      .filter((v) => !ctx.varMap[String(v.id).toLowerCase()])
      .map((v) => ({ id: String(v.id).toLowerCase(), name: v.name, type: v.type, value: v.value, flows: usage[String(v.id).toLowerCase()] || 0 }))
      .sort((a, b) => (b.flows > 0) - (a.flows > 0) || a.name.localeCompare(b.name));
  }

  /** Install an app from the Homey App Store on this Homey (same channel as on the other Homey). */
  async installApp({ id, channel }) {
    if (!id || !/^[a-z0-9._-]+$/i.test(id)) throw new Error('Invalid app id');
    await this.target.apps.installFromAppStore({ id, channel: channel === 'test' ? 'test' : 'live', waitForInstall: true });
    this.cache = {};
    return true;
  }

  /** Create variables of the other Homey here (same name, type and current value). */
  async createVariables({ ids }) {
    const ctx = await this.context();
    const results = [];
    for (const raw of ids || []) {
      const u = String(raw).toLowerCase();
      const v = ctx.src.variables[u];
      if (!v || ctx.varMap[u]) continue;
      try {
        const created = await this.target.logic.createVariable({ variable: { name: v.name, type: v.type, value: v.value } });
        ctx.varMap[u] = created.id;
        results.push({ type: 'variable', name: v.name, ok: true, id: created.id, srcId: u });
      } catch (err) {
        results.push({ type: 'variable', name: v.name, ok: false, error: err.message });
      }
    }
    this.cache = {};
    return results;
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
      if (needed.size) {
        for (const r of await this.createVariables({ ids: [...needed] })) {
          if (r.ok) { ctx.varMap[r.srcId] = r.id; ctx.idMap[r.srcId] = r.id; }
          results.push({ type: 'variable', name: r.name, ok: r.ok, error: r.error });
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
