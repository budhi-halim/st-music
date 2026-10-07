/* A single persistent HTMLAudioElement. No Web Audio routing or tab-based pauses. */
(() => {
  'use strict';
  const { clamp, sourceCandidates } = window.SweetTimesLogic;
  class AudioEngine extends EventTarget {
    constructor(audio) {
      super();
      this.audio = audio;
      if ('preservesPitch' in audio) audio.preservesPitch = true;
      this.track = null;
      this.status = 'idle';
      this.message = '';
      this.format = '';
      this.wanted = false;
      this.generation = 0;
      this.attempt = 0;
      this.playRequest = 0;
      this.sourceIndex = -1;
      this.candidates = [];
      this.pendingSeek = 0;
      this.sourceEvents = null;
      this.watchdog = null;
      this.rate = 1;
    }
    get duration() { return Number.isFinite(this.audio.duration) && this.audio.duration > 0 ? this.audio.duration : NaN; }
    get currentTime() { return Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0; }
    get busy() { return this.status === 'loading'; }
    emit(type, detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }
    state(status, message = '') {
      this.status = status;
      this.message = message;
      this.emit('state', { status, message });
    }
    clearWatchdog() { clearTimeout(this.watchdog); this.watchdog = null; }
    armWatchdog(generation, attempt) {
      this.clearWatchdog();
      this.watchdog = setTimeout(() => {
        if (generation !== this.generation || attempt !== this.attempt) return;
        this.failSource(generation, attempt);
      }, 30000);
    }
    load(track, { autoplay = false, startAt = 0 } = {}) {
      this.generation += 1;
      this.playRequest += 1;
      this.sourceEvents?.abort();
      this.clearWatchdog();
      this.audio.pause();
      this.track = track;
      this.wanted = Boolean(autoplay);
      this.format = '';
      this.pendingSeek = Number.isFinite(startAt) ? Math.max(0, startAt) : 0;
      this.candidates = sourceCandidates(track.sources, type => this.audio.canPlayType(type));
      this.emit('track', { track });
      this.trySource(0);
    }
    trySource(index) {
      this.sourceEvents?.abort();
      this.clearWatchdog();
      this.playRequest += 1;
      this.audio.pause();
      this.sourceIndex = index;
      const source = this.candidates[index];
      if (!source) {
        this.wanted = false;
        this.format = '';
        this.state('error', `Cannot load ${this.track.id}. Check audio/ or your connection.`);
        this.emit('error', { track: this.track });
        return;
      }
      const generation = this.generation;
      const attempt = ++this.attempt;
      const controller = new AbortController();
      this.sourceEvents = controller;
      const listen = (type, handler) => this.audio.addEventListener(type, event => {
        if (generation === this.generation && attempt === this.attempt) handler(event);
      }, { signal: controller.signal });
      this.format = '';
      this.state('loading', index > 0 ? `Trying ${source.label}…` : 'Loading…');
      listen('loadedmetadata', () => {
        this.clearWatchdog();
        this.audio.playbackRate = this.rate;
        this.format = source.label;
        if (this.pendingSeek > 0 && Number.isFinite(this.duration)) {
          const target = clamp(this.pendingSeek, 0, Math.max(0, this.duration - .05));
          try { this.audio.currentTime = target; this.pendingSeek = 0; } catch { /* Retry on canplay. */ }
        }
        this.emit('metadata', { track: this.track, duration: this.duration, format: source.label });
        if (!this.wanted) this.state('paused');
        else this.armWatchdog(generation, attempt);
      });
      listen('durationchange', () => {
        if (Number.isFinite(this.duration)) this.emit('duration', { track: this.track, duration: this.duration });
      });
      listen('canplay', () => {
        this.clearWatchdog();
        if (this.pendingSeek > 0 && Number.isFinite(this.duration)) {
          try { this.audio.currentTime = clamp(this.pendingSeek, 0, this.duration - .05); this.pendingSeek = 0; } catch { /* A later user seek remains available. */ }
        }
        if (!this.wanted && !this.audio.paused) this.audio.pause();
        if (!this.wanted && this.status !== 'error') this.state('paused');
      });
      listen('playing', () => {
        this.clearWatchdog();
        this.wanted = true;
        this.state('playing');
      });
      listen('pause', () => {
        if (!this.audio.paused || this.audio.ended || this.status === 'error') return;
        // A real pause (including OS interruption) must not trigger an auto-resume.
        this.wanted = false;
        this.clearWatchdog();
        this.state('paused');
      });
      listen('waiting', () => {
        if (!this.wanted) return;
        this.state('loading', 'Buffering…');
        this.armWatchdog(generation, attempt);
      });
      listen('timeupdate', () => this.emit('time', { currentTime: this.currentTime, duration: this.duration }));
      listen('progress', () => this.emit('buffer'));
      listen('seeked', () => this.emit('time', { currentTime: this.currentTime, duration: this.duration }));
      listen('volumechange', () => this.emit('volume', { volume: this.audio.volume, muted: this.audio.muted }));
      listen('ratechange', () => this.emit('rate', { rate: this.audio.playbackRate }));
      listen('ended', () => {
        this.wanted = false;
        this.clearWatchdog();
        this.state('ended');
        this.emit('ended', { track: this.track });
      });
      listen('error', () => {
        // Aborts caused by changing tracks are not source failures.
        if (!this.audio.error || this.audio.error.code === 1) return;
        this.failSource(generation, attempt);
      });
      this.audio.src = source.url;
      this.audio.preload = 'metadata';
      this.audio.load();
      this.audio.playbackRate = this.rate;
      this.armWatchdog(generation, attempt);
      if (this.wanted) this.requestPlay();
    }
    failSource(generation, attempt) {
      if (generation !== this.generation || attempt !== this.attempt || this.status === 'error') return;
      if (this.currentTime > 0) this.pendingSeek = this.currentTime;
      // trySource increments attempt before a second queued error can act.
      this.trySource(this.sourceIndex + 1);
    }
    requestPlay() {
      const generation = this.generation;
      const attempt = this.attempt;
      const request = ++this.playRequest;
      this.wanted = true;
      this.state('loading', this.audio.readyState >= 3 ? '' : 'Loading…');
      this.armWatchdog(generation, attempt);
      let promise;
      try { promise = this.audio.play(); } catch (error) { promise = Promise.reject(error); }
      if (promise?.catch) promise.catch(error => {
        if (generation !== this.generation || attempt !== this.attempt || request !== this.playRequest) return;
        if (error.name === 'AbortError') return;
        if (error.name === 'NotAllowedError') {
          this.wanted = false;
          this.clearWatchdog();
          this.state('paused', 'Tap Play to start playback.');
          return;
        }
        this.failSource(generation, attempt);
      });
    }
    play() {
      if (!this.track) return;
      if (this.status === 'error') { this.load(this.track, { autoplay: true, startAt: this.pendingSeek }); return; }
      if (this.audio.ended || (Number.isFinite(this.duration) && this.currentTime >= this.duration - .03)) this.seek(0);
      this.requestPlay();
    }
    pause() {
      this.wanted = false;
      this.playRequest += 1;
      this.clearWatchdog();
      this.audio.pause();
      if (this.status !== 'error') this.state('paused');
    }
    toggle() { if (this.wanted || !this.audio.paused) this.pause(); else this.play(); }
    seek(time) {
      if (!Number.isFinite(time)) return;
      if (!Number.isFinite(this.duration)) { this.pendingSeek = Math.max(0, time); return; }
      try {
        this.audio.currentTime = clamp(time, 0, this.duration);
        this.pendingSeek = 0;
        this.emit('time', { currentTime: this.currentTime, duration: this.duration });
      } catch { this.pendingSeek = Math.max(0, time); }
    }
    setRate(rate) {
      this.rate = clamp(Number(rate), .5, 2);
      try { this.audio.playbackRate = this.rate; } catch { this.rate = 1; }
      this.emit('rate', { rate: this.rate });
    }
    setVolume(value) {
      const volume = clamp(Number(value), 0, 1);
      try { this.audio.volume = volume; } catch { /* Hardware-only volume platforms. */ }
      if (volume > 0) this.audio.muted = false;
      this.emit('volume', { volume: this.audio.volume, muted: this.audio.muted });
      return Math.abs(this.audio.volume - volume) < .01;
    }
    setMuted(value) {
      this.audio.muted = Boolean(value);
      this.emit('volume', { volume: this.audio.volume, muted: this.audio.muted });
    }
  }

  /* Lazy, serial metadata reads: only visible rows, no full-file fetch/decode. */
  class MetadataReader {
    constructor(onDuration, shouldWait = () => false) {
      this.onDuration = onDuration;
      this.shouldWait = shouldWait;
      this.pending = [];
      this.requested = new Set();
      this.running = false;
      this.audio = new Audio();
      this.audio.preload = 'metadata';
    }
    enqueue(track) {
      if (this.requested.has(track.id)) return;
      this.requested.add(track.id);
      this.pending.push(track);
      this.pump();
    }
    async pump() {
      if (this.running) return;
      this.running = true;
      while (this.pending.length) {
        if (this.shouldWait() || document.hidden) {
          await new Promise(resolve => setTimeout(resolve, 1200));
          continue;
        }
        const track = this.pending.shift();
        const candidates = sourceCandidates(track.sources, type => this.audio.canPlayType(type));
        for (const source of candidates) {
          const duration = await this.read(source.url);
          if (Number.isFinite(duration) && duration > 0) {
            this.onDuration(track.id, duration);
            break;
          }
        }
      }
      this.running = false;
    }
    read(url) {
      return new Promise(resolve => {
        const controller = new AbortController();
        let done = false;
        let timer;
        const finish = value => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          controller.abort();
          this.audio.pause();
          this.audio.removeAttribute('src');
          this.audio.load();
          resolve(value);
        };
        const found = () => { if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) finish(this.audio.duration); };
        this.audio.addEventListener('loadedmetadata', found, { signal: controller.signal });
        this.audio.addEventListener('durationchange', found, { signal: controller.signal });
        this.audio.addEventListener('error', () => finish(NaN), { signal: controller.signal });
        timer = setTimeout(() => finish(NaN), 10000);
        this.audio.src = url;
        this.audio.load();
      });
    }
  }
  window.SweetTimesAudio = Object.freeze({ AudioEngine, MetadataReader });
})();
