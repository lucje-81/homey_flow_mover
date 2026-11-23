'use strict';

module.exports = {
  async getStatus({ homey }) {
    return homey.app.status();
  },

  async connect({ homey, body }) {
    return homey.app.connect(body || {});
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

  async migrate({ homey, body }) {
    return homey.app.migrate(body || {});
  },
};
