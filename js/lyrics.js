/* Line-synced lyrics; audio.currentTime is the only playback clock.
   No AI, service worker, remote library, or second audio player is used here. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  function cueAt(cues, time) {
    let left = 0, right = cues.length - 1, found = -1;
    while (left <= right) {
      const mid = (left + right) >>> 1;
      if (cues[mid].start <= time) { found = mid; left = mid + 1; }
      else right = mid - 1;
    }
    const cue = cues[found];
    return { active: cue && time < cue.end ? cue.index : -1,
      focus: cue ? cue.index : (cues[0]?.index ?? -1) };
  }
  function validateRecord(record, id) {
    if (!record || record.id !== id || !Array.isArray(record.lines) || record.lines.length > 2000) return null;
    const lines = []; let end = 0;
    for (const line of record.lines) {
      if (!line || typeof line.text !== 'string' || !line.text.trim() || line.text.length > 3000) return null;
      const item = { text: line.text, section: typeof line.section === 'string' ? line.section : '',
        sectionIndex: Number.isInteger(line.sectionIndex) ? line.sectionIndex : 0, start: null, end: null };
      if (finite(line.start) && finite(line.end)) {
        if (line.start < end - .001 || line.start < 0 || line.end <= line.start) return null;
        item.start = line.start; item.end = line.end; end = line.end;
      } else if (line.start != null || line.end != null) return null;
      lines.push(item);
    }
    return { ...record, lines };
  }
  class LyricsView {
    constructor(engine) {
      this.engine = engine; this.enabled = false; this.follow = true;
      this.library = null; this.request = null; this.record = null; this.cues = []; this.nodes = [];
      this.active = -1; this.focus = -1; this.frame = 0; this.fetchId = 0;
      this.scroller = $('lyrics-scroll'); this.panel = $('lyrics-panel');
      this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
      $('follow-lyrics').addEventListener('click', () => this.resumeFollow());
      $('lyrics-reload').addEventListener('click', () => this.load(true));
      this.scroller.addEventListener('wheel', () => this.suspendFollow(), { passive: true });
      this.scroller.addEventListener('touchstart', () => this.suspendFollow(), { passive: true });
      this.scroller.addEventListener('pointerdown', () => this.suspendFollow(), { passive: true });
      this.scroller.addEventListener('keydown', event => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
          this.suspendFollow(); event.stopPropagation();
        }
      });
      $('lyrics-lines').addEventListener('click', event => {
        const button = event.target.closest('button[data-line-index]');
        if (!button) return;
        const line = this.record?.lines[Number(button.dataset.lineIndex)];
        if (finite(line?.start)) { this.engine.seek(line.start); this.resumeFollow(); }
      });
      engine.addEventListener('track', () => { this.render(); this.refreshLayout(); });
      engine.addEventListener('state', () => this.refreshLayout());
      engine.addEventListener('time', () => this.update());
      engine.addEventListener('metadata', () => { this.checkDuration(); this.update(); });
      document.addEventListener('visibilitychange', () => this.refreshLayout());
      this.reduced.addEventListener('change', () => this.refreshLayout());
      this.observer = new ResizeObserver(() => this.refreshLayout());
      this.observer.observe(this.scroller);
    }
    toggle() {
      this.enabled = !this.enabled;
      this.panel.hidden = !this.enabled;
      $('cover-art').hidden = this.enabled;
      $('player-panel').classList.toggle('lyrics-mode', this.enabled);
      document.querySelector('[data-action="lyrics"]').setAttribute('aria-pressed', String(this.enabled));
      if (this.enabled && !this.library) this.load();
      this.refreshLayout();
    }
    async load(force = false) {
      if (this.request && !force) return this.request;
      const generation = ++this.fetchId;
      $('lyrics-status').textContent = 'Loading lyrics…';
      $('lyrics-reload').disabled = true;
      this.request = (async () => {
        try {
          const response = await fetch('data/lyrics.json', { cache: 'no-store' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          if (data.schemaVersion !== 1 || !data.tracks || typeof data.tracks !== 'object') throw new Error('Invalid lyric data');
          if (generation !== this.fetchId) return;
          this.library = data.tracks; this.render(); this.refreshLayout();
        } catch (error) {
          if (generation !== this.fetchId) return;
          $('lyrics-status').textContent = 'Lyrics unavailable';
          if (!this.library) { $('lyrics-lines').textContent = 'Could not load lyrics.'; this.cues = []; }
          console.warn('Lyrics:', error.message);
        } finally {
          if (generation === this.fetchId) { this.request = null; $('lyrics-reload').disabled = false; }
        }
      })();
      return this.request;
    }
    render() {
      this.active = -1; this.focus = -1; this.follow = true;
      $('follow-lyrics').hidden = true; this.cues = []; this.nodes = [];
      const id = this.engine.track?.id;
      this.record = validateRecord(this.library?.[id], id);
      const host = $('lyrics-lines'); host.replaceChildren();
      if (!this.record) {
        this.panel.dataset.synced = 'false';
        $('lyrics-status').textContent = this.library ? 'No lyrics' : 'Loading lyrics…';
        return;
      }
      const fragment = document.createDocumentFragment(); let sectionIndex = null;
      this.record.lines.forEach((line, index) => {
        if (line.section && sectionIndex !== line.sectionIndex) {
          const heading = document.createElement('p'); heading.className = 'lyric-section';
          heading.textContent = line.section; fragment.append(heading); sectionIndex = line.sectionIndex;
        }
        const timed = finite(line.start);
        const node = document.createElement(timed ? 'button' : 'p'); node.className = 'lyric-line';
        node.textContent = line.text;
        if (timed) {
          node.type = 'button'; node.dataset.lineIndex = String(index);
          node.title = `${window.SweetTimesLogic.formatTime(line.start)} · ${line.text}`;
          node.setAttribute('aria-label', `Seek to ${window.SweetTimesLogic.formatTime(line.start)}: ${line.text}`);
          this.cues.push({ index, start: line.start, end: line.end });
        }
        this.nodes.push(node); fragment.append(node);
      });
      host.append(fragment); this.panel.dataset.synced = String(this.cues.length > 0); this.scroller.scrollTop = 0;
      this.setStatus(); this.update(true);
    }
    setStatus() {
      const timed = this.cues.length;
      $('lyrics-status').textContent = !timed ? 'Not synced' :
        this.record?.status === 'needs-review' ? 'Auto-timed · Review' : 'Auto-timed';
    }
    checkDuration() {
      if (!this.record || !this.cues.length) return;
      this.setStatus();
      if (finite(this.record.duration) && finite(this.engine.duration) && Math.abs(this.record.duration - this.engine.duration) > .5) {
        $('lyrics-status').textContent = 'Timing / audio mismatch';
      }
    }
    suspendFollow() {
      if (!this.cues.length) return;
      this.follow = false; $('follow-lyrics').hidden = false;
      // Stop an in-flight programmatic smooth scroll before handing control over.
      this.scroller.scrollTo({ top: this.scroller.scrollTop, behavior: 'instant' });
    }
    resumeFollow() {
      this.follow = true; $('follow-lyrics').hidden = true; this.update(true);
    }
    visible() { return this.enabled && !document.hidden && this.panel.getClientRects().length > 0; }
    update(force = false) {
      if (!this.visible() || !this.cues.length) return;
      const current = cueAt(this.cues, this.engine.currentTime);
      if (current.active !== this.active) {
        if (this.nodes[this.active]) { this.nodes[this.active].classList.remove('is-active'); this.nodes[this.active].removeAttribute('aria-current'); }
        this.active = current.active;
        if (this.nodes[this.active]) { this.nodes[this.active].classList.add('is-active'); this.nodes[this.active].setAttribute('aria-current', 'true'); }
      }
      if (this.follow && (force || current.focus !== this.focus)) this.center(current.focus, force);
      this.focus = current.focus;
    }
    center(index, immediate) {
      const node = this.nodes[index]; if (!node) return;
      const box = node.getBoundingClientRect(), viewport = this.scroller.getBoundingClientRect();
      const top = this.scroller.scrollTop + box.top - viewport.top - (viewport.height - box.height) / 2;
      this.scroller.scrollTo({ top: Math.max(0, top), behavior: immediate || this.reduced.matches ? 'instant' : 'smooth' });
    }
    refreshLayout() {
      cancelAnimationFrame(this.frame); this.frame = 0;
      if (!this.visible()) return;
      // End padding lets even the final line reach the focus area.
      this.scroller.style.setProperty('--lyrics-space', `${Math.max(24, this.scroller.clientHeight / 2)}px`);
      this.update(true);
      if (this.engine.status !== 'playing') return;
      const tick = () => {
        if (!this.visible() || this.engine.status !== 'playing') { this.frame = 0; return; }
        this.update(); this.frame = requestAnimationFrame(tick);
      };
      this.frame = requestAnimationFrame(tick);
    }
  }
  window.SweetTimesLyrics = Object.freeze({ LyricsView, cueAt, validateRecord });
})();
