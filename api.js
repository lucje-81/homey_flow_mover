'use strict';

module.exports = {
  async getStatus({ homey }) {
    return homey.app.status();
  },

  async connect({ homey, body }) {
    return homey.app.connect(body || {});
  },

  async connectTarget({ homey, body }) {
    return homey.app.connectTarget(body || {});
  },

  async getAnalysis({ homey }) {
    return homey.app.analyse();
  },

  async setDeviceMap({ homey, body }) {
    return homey.app.setDeviceMap(body || {});
  },

  async resetDeviceMap({ homey }) {
    return homey.app.resetDeviceMap();
  },

  async installApp({ homey, body }) {
    return homey.app.installApp(body || {});
  },

  async createVariables({ homey, body }) {
    return homey.app.createVariables(body || {});
  },

  async applyZones({ homey, body }) {
    return homey.app.applyZones(body || {});
  },

  async migrateDashboards({ homey, body }) {
    return homey.app.migrateDashboards(body || {});
  },

  async getFavorites({ homey }) {
    return homey.app.analyseFavorites();
  },

  async copyFavorites({ homey }) {
    return homey.app.copyFavorites();
  },

  async createGroups({ homey, body }) {
    return homey.app.createGroups(body || {});
  },

  async inviteUsers({ homey, body }) {
    return homey.app.inviteUsers(body || {});
  },

  async getLinkTargets({ homey }) {
    return homey.app.linkTargets();
  },

  async setLinkTarget({ homey, body }) {
    return homey.app.setLinkTarget(body || {});
  },

  async getMoves({ homey }) {
    return homey.app.listMoves();
  },

  async switchFlows({ homey, body }) {
    return homey.app.switchFlows(body || {});
  },

  async refresh({ homey }) {
    return homey.app.refresh();
  },

  async migrate({ homey, body }) {
    return homey.app.migrate(body || {});
  },
};
