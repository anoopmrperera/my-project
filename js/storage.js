/* Local-only storage. Nothing here ever leaves the device. */
const Store = (() => {
  const SESSIONS_KEY = 'wrr.sessions.v1';
  const SETTINGS_KEY = 'wrr.settings.v1';
  const DEFAULT_SETTINGS = { mode: 'mic', sensitivity: 6, pauseMs: 1000 };

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  return {
    loadSettings() {
      return Object.assign({}, DEFAULT_SETTINGS, read(SETTINGS_KEY, {}));
    },
    saveSettings(s) { write(SETTINGS_KEY, s); },

    /** Newest first. */
    loadSessions() {
      const list = read(SESSIONS_KEY, []);
      return Array.isArray(list) ? list.sort((a, b) => b.createdAt - a.createdAt) : [];
    },
    /** Returns false if the browser refused (storage full / private mode). */
    saveSessions(list) { return write(SESSIONS_KEY, list); },

    addSession(session) {
      const list = this.loadSessions();
      list.unshift(session);
      return this.saveSessions(list);
    },
    updateSession(id, patch) {
      const list = this.loadSessions();
      const s = list.find((x) => x.id === id);
      if (!s) return false;
      Object.assign(s, patch);
      return this.saveSessions(list);
    },
    deleteSession(id) {
      return this.saveSessions(this.loadSessions().filter((s) => s.id !== id));
    },
    /** Merge imported sessions by id. Returns number added. */
    importSessions(items) {
      const list = this.loadSessions();
      const ids = new Set(list.map((s) => s.id));
      let added = 0;
      for (const s of items) {
        if (s && s.id && Array.isArray(s.segments) && !ids.has(s.id)) {
          list.push(s);
          ids.add(s.id);
          added++;
        }
      }
      if (!this.saveSessions(list)) return -1;
      return added;
    },
  };
})();
