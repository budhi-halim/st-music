/* Pure queue/state helpers. No DOM, storage, or audio dependencies. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SweetTimesLogic = api;
})(typeof globalThis === 'undefined' ? this : globalThis, () => {
  'use strict';
  const REPEAT_MODES = Object.freeze(['off', 'all', 'one']);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '—:—';
    const value = Math.floor(seconds);
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const remainder = String(value % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`;
  }
  function shuffled(items, random = Math.random) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = Math.floor(clamp(random(), 0, .999999999999) * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
  function sourceCandidates(sources, canPlayType) {
    const supported = sources.filter(source => {
      try { return Boolean(canPlayType(source.type)); } catch { return false; }
    });
    // Keep the explicit preference order. Some engines under-report support;
    // after advertised formats fail, also try the remaining real files once.
    return [...supported, ...sources.filter(source => !supported.includes(source))];
  }
  function filterTracks(tracks, filter, query, favorites = new Set()) {
    const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    return tracks.filter(track => {
      if (filter === 'favorites' && !favorites.has(track.id)) return false;
      if (filter !== 'all' && filter !== 'favorites' && track.source !== filter) return false;
      const haystack = `${track.title} ${track.id} ${track.sourceName} ${track.subtitle}`.toLowerCase();
      return terms.every(term => haystack.includes(term));
    });
  }
  class PlaybackQueue {
    constructor(ids = [], { random = Math.random, shuffle = false, repeat = 'off' } = {}) {
      this.random = random;
      this.shuffle = Boolean(shuffle);
      this.repeat = REPEAT_MODES.includes(repeat) ? repeat : 'off';
      this.base = [];
      this.order = [];
      this.cursor = 0;
      this.previousCycles = [];
      this.forwardCycles = [];
      this.reset(ids, ids[0]);
    }
    get current() { return this.order[this.cursor] || null; }
    reset(ids, selected) {
      this.base = [...new Set(ids.filter(id => typeof id === 'string'))];
      if (!this.base.length) { this.order = []; this.cursor = 0; return; }
      const current = this.base.includes(selected) ? selected : this.base[0];
      this.order = this.shuffle ? [current, ...shuffled(this.base.filter(id => id !== current), this.random)] : [...this.base];
      this.cursor = this.order.indexOf(current);
      this.previousCycles = [];
      this.forwardCycles = [];
    }
    setShuffle(value) {
      if (this.shuffle === Boolean(value)) return;
      this.shuffle = Boolean(value);
      // Preserve the exact played prefix, so Previous still retraces playback.
      const pastAndCurrent = this.order.slice(0, this.cursor + 1);
      const remaining = this.base.filter(id => !pastAndCurrent.includes(id));
      this.order = [...pastAndCurrent, ...(this.shuffle ? shuffled(remaining, this.random) : remaining)];
      this.forwardCycles = [];
    }
    cycleRepeat() {
      this.repeat = REPEAT_MODES[(REPEAT_MODES.indexOf(this.repeat) + 1) % REPEAT_MODES.length];
      return this.repeat;
    }
    next({ automatic = false } = {}) {
      if (!this.current) return { kind: 'stop', id: null };
      if (automatic && this.repeat === 'one') return { kind: 'restart', id: this.current };
      if (this.cursor + 1 < this.order.length) {
        this.cursor += 1;
        return { kind: 'track', id: this.current };
      }
      // Manual Next bypasses repeat-one, but does not silently wrap with repeat off.
      if (this.forwardCycles.length) {
        this.previousCycles.push([...this.order]);
        this.order = this.forwardCycles.pop();
        this.cursor = 0;
        return { kind: 'track', id: this.current };
      }
      if (this.repeat !== 'all') return { kind: 'stop', id: this.current };
      const last = this.current;
      this.previousCycles.push([...this.order]);
      if (this.previousCycles.length > 20) this.previousCycles.shift();
      this.order = this.shuffle ? shuffled(this.base, this.random) : [...this.base];
      // Never immediately repeat the last track when reshuffling a multi-track list.
      if (this.shuffle && this.order.length > 1 && this.order[0] === last) {
        [this.order[0], this.order[1]] = [this.order[1], this.order[0]];
      }
      this.cursor = 0;
      return { kind: 'track', id: this.current };
    }
    previous(elapsed = 0) {
      if (!this.current) return { kind: 'stop', id: null };
      // At exactly one second, restart as well; below one second, go back.
      if (elapsed >= 1) return { kind: 'restart', id: this.current };
      if (this.cursor > 0) {
        this.cursor -= 1;
        return { kind: 'track', id: this.current };
      }
      if (this.previousCycles.length) {
        this.forwardCycles.push([...this.order]);
        this.order = this.previousCycles.pop();
        this.cursor = this.order.length - 1;
        return { kind: 'track', id: this.current };
      }
      if (this.repeat === 'all' && this.order.length > 1) {
        this.cursor = this.order.length - 1;
        return { kind: 'track', id: this.current };
      }
      return { kind: 'restart', id: this.current };
    }
    jump(index) {
      if (!Number.isInteger(index) || index < 0 || index >= this.order.length) return null;
      this.cursor = index;
      this.forwardCycles = [];
      return this.current;
    }
    snapshot() {
      return { base: [...this.base], order: [...this.order], cursor: this.cursor, shuffle: this.shuffle, repeat: this.repeat };
    }
    restore(snapshot, validIds) {
      if (!snapshot || typeof snapshot !== 'object') return false;
      const valid = new Set(validIds);
      const base = Array.isArray(snapshot.base) ? snapshot.base : [];
      const order = Array.isArray(snapshot.order) ? snapshot.order : [];
      if (!base.length || base.length !== order.length || new Set(base).size !== base.length || new Set(order).size !== order.length) return false;
      if (!base.every(id => valid.has(id)) || !order.every(id => base.includes(id))) return false;
      if (!Number.isInteger(snapshot.cursor) || snapshot.cursor < 0 || snapshot.cursor >= order.length) return false;
      this.base = [...base];
      this.order = [...order];
      this.cursor = snapshot.cursor;
      this.shuffle = Boolean(snapshot.shuffle);
      this.repeat = REPEAT_MODES.includes(snapshot.repeat) ? snapshot.repeat : 'off';
      this.previousCycles = [];
      this.forwardCycles = [];
      return true;
    }
  }
  return Object.freeze({ PlaybackQueue, REPEAT_MODES, clamp, formatTime, shuffled, filterTracks, sourceCandidates });
});
