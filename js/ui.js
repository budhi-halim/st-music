(() => {
  'use strict';
  const tracks = window.SweetTimesTracks;
  const { PlaybackQueue, clamp, formatTime, filterTracks } = window.SweetTimesLogic;
  const { AudioEngine, MetadataReader } = window.SweetTimesAudio;
  const byId = new Map(tracks.map(track => [track.id, track]));
  const $ = id => document.getElementById(id);
  const all = selector => [...document.querySelectorAll(selector)];
  const STORAGE_KEY = 'sweet-times-music:v1';
  const audio = $('audio');
  const engine = new AudioEngine(audio);
  const lyrics = new window.SweetTimesLyrics.LyricsView(engine);
  let saved = {};
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) saved = value;
  } catch { /* Storage is optional; private/restricted browsing still works. */ }
  const favorites = new Set((Array.isArray(saved.favorites) ? saved.favorites : []).filter(id => byId.has(id)));
  const queue = new PlaybackQueue(tracks.map(track => track.id));
  queue.restore(saved.queue, tracks.map(track => track.id));
  const durations = new Map();
  const rows = new Map();
  let filter = 'all';
  let query = '';
  let visibleTracks = tracks;
  let seeking = false;
  let showRemaining = Boolean(saved.showRemaining);
  let lastNonzeroVolume = clamp(Number(saved.lastNonzeroVolume) || .8, .01, 1);
  let lastSavedAt = 0;
  let frame = 0;
  let toastTimer;
  let themeOverride = null;
  let deferredInstall = null;
  let metadataObserver = null;
  let pendingUiFrame = 0;
  const desktop = matchMedia('(min-width: 900px)');
  const systemDark = matchMedia('(prefers-color-scheme: dark)');

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `assets/icons.svg#${name}`);
    svg.append(use);
    return svg;
  }
  function setIcon(element, name) {
    const use = element.querySelector('use');
    const href = `assets/icons.svg#${name}`;
    if (use && use.getAttribute('href') !== href) use.setAttribute('href', href);
  }
  function label(element, text) { element.setAttribute('aria-label', text); element.title = text; }
  function toast(message) {
    $('toast').textContent = message;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2800);
  }
  function saveState(force = false) {
    const now = Date.now();
    if (!force && now - lastSavedAt < 4000) return;
    lastSavedAt = now;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        queue: queue.snapshot(),
        position: Math.max(engine.currentTime, engine.pendingSeek || 0),
        volume: audio.volume,
        muted: audio.muted,
        lastNonzeroVolume,
        rate: engine.rate,
        favorites: [...favorites],
        showRemaining,
      }));
    } catch { /* Playback does not depend on persistence. */ }
  }
  function applyTheme() {
    const dark = themeOverride === null ? systemDark.matches : themeOverride === 'dark';
    // Theme palettes live exclusively in light-dark(); this only chooses color-scheme.
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    setIcon($('theme-button'), dark ? 'sun' : 'moon');
    label($('theme-button'), dark ? 'Switch to light mode' : 'Switch to dark mode');
    $('theme-button').setAttribute('aria-pressed', String(dark));
    $('theme-color').content = dark ? '#171412' : '#f7f4f1';
  }
  $('theme-button').addEventListener('click', () => {
    const dark = themeOverride === null ? systemDark.matches : themeOverride === 'dark';
    themeOverride = dark ? 'light' : 'dark';
    applyTheme();
  });
  systemDark.addEventListener('change', () => { if (themeOverride === null) applyTheme(); });
  applyTheme();

  function makeTrackRow(track, index) {
    const row = document.createElement('li');
    row.className = 'track-row';
    row.dataset.id = track.id;
    const main = document.createElement('button');
    main.className = 'track-main';
    main.dataset.track = track.id;
    label(main, `Play ${track.title}`);
    const number = document.createElement('span');
    number.className = 'track-number';
    number.textContent = String(index + 1).padStart(2, '0');
    number.setAttribute('aria-hidden', 'true');
    const art = document.createElement('span');
    art.className = 'track-art';
    art.dataset.source = track.source;
    art.dataset.variant = track.variant;
    art.setAttribute('aria-hidden', 'true');
    art.append(icon('wave'));
    const eq = document.createElement('span');
    eq.className = 'equalizer';
    eq.append(...[0, 1, 2].map(() => document.createElement('i')));
    art.append(eq);
    const copy = document.createElement('span');
    copy.className = 'track-copy';
    const title = document.createElement('span');
    title.className = 'track-title';
    title.textContent = track.title;
    const subtitle = document.createElement('span');
    subtitle.className = 'track-subtitle';
    subtitle.textContent = track.id;
    copy.append(title, subtitle);
    main.append(number, art, copy);
    const duration = document.createElement('span');
    duration.className = 'track-duration';
    duration.textContent = '—:—';
    const favorite = document.createElement('button');
    favorite.className = 'icon-button track-favorite';
    favorite.dataset.favorite = track.id;
    favorite.setAttribute('aria-pressed', 'false');
    favorite.append(icon('heart'));
    row.append(main, duration, favorite);
    rows.set(track.id, { row, main, favorite, duration });
    return row;
  }
  const fragment = document.createDocumentFragment();
  tracks.forEach((track, index) => fragment.append(makeTrackRow(track, index)));
  $('track-list').append(fragment);

  function renderLibrary() {
    visibleTracks = filterTracks(tracks, filter, query, favorites);
    const visibleIds = new Set(visibleTracks.map(track => track.id));
    for (const track of tracks) {
      const refs = rows.get(track.id);
      refs.row.hidden = !visibleIds.has(track.id);
      if (!refs.row.hidden && metadataObserver) metadataObserver.observe(refs.row);
    }
    $('library-count').textContent = `${visibleTracks.length} ${visibleTracks.length === 1 ? 'track' : 'tracks'}`;
    $('play-all').disabled = visibleTracks.length === 0;
    $('empty-state').hidden = visibleTracks.length > 0;
    $('empty-title').textContent = filter === 'favorites' && !query ? 'No favorites yet' : 'No tracks found';
    $('search-clear').hidden = !query;
    $('favorites-count').textContent = String(favorites.size);
    for (const button of all('[data-filter]')) button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
    renderRows();
  }
  function renderRows() {
    const playing = engine.status === 'playing';
    for (const track of tracks) {
      const { row, main, favorite, duration } = rows.get(track.id);
      const current = track.id === queue.current;
      row.classList.toggle('is-current', current);
      row.classList.toggle('is-playing', current && playing);
      if (current) main.setAttribute('aria-current', 'true'); else main.removeAttribute('aria-current');
      label(main, `${current && (playing || engine.wanted) ? 'Pause' : 'Play'} ${track.title}`);
      favorite.setAttribute('aria-pressed', String(favorites.has(track.id)));
      label(favorite, `${favorites.has(track.id) ? 'Remove' : 'Add'} ${track.title} ${favorites.has(track.id) ? 'from' : 'to'} favorites`);
      duration.textContent = formatTime(durations.get(track.id));
    }
  }
  function rememberDuration(id, duration) {
    if (!Number.isFinite(duration) || duration <= 0) return;
    durations.set(id, duration);
    const refs = rows.get(id);
    if (refs) refs.duration.textContent = formatTime(duration);
  }
  const metadataReader = new MetadataReader(rememberDuration, () => engine.busy);
  if ('IntersectionObserver' in window) {
    metadataObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        metadataObserver.unobserve(entry.target);
        const track = byId.get(entry.target.dataset.id);
        if (track && track.id !== queue.current && !durations.has(track.id)) metadataReader.enqueue(track);
      }
    }, { root: $('track-scroll'), rootMargin: '30px 0px', threshold: .1 });
  }

  function updateCurrentTrack() {
    const track = byId.get(queue.current);
    if (!track) return;
    $('current-title').textContent = $('mini-title').textContent = track.title;
    $('current-subtitle').textContent = $('mini-subtitle').textContent = track.subtitle;
    $('cover-source').textContent = track.sourceName;
    $('cover-code').textContent = `${String(track.prompt).padStart(2, '0')} / ${track.variant.toUpperCase()}`;
    $('cover-art').dataset.source = track.source;
    $('cover-art').dataset.variant = track.variant;
    label(document.querySelector('.mini-info'), `Open now playing: ${track.title}`);
    const favoriteButton = document.querySelector('.favorite-current');
    favoriteButton.setAttribute('aria-pressed', String(favorites.has(track.id)));
    label(favoriteButton, favorites.has(track.id) ? 'Remove from favorites' : 'Add to favorites');
    $('download-track').textContent = track.title;
    for (const [id, source] of [['download-opus', track.sources[0]], ['download-aac', track.sources[1]]]) {
      $(id).href = source.url;
      $(id).setAttribute('download', source.url.split('/').pop());
    }
    updateMediaMetadata(track);
    renderRows();
    renderModes();
    if ($('queue-dialog').open) renderQueue();
  }
  function renderModes() {
    for (const button of all('[data-action="shuffle"]')) {
      button.setAttribute('aria-pressed', String(queue.shuffle));
      label(button, `Shuffle ${queue.shuffle ? 'on. Turn off' : 'off. Turn on'}`);
    }
    const repeatLabels = { off: 'Repeat off. Enable repeat all', all: 'Repeat all. Enable repeat one', one: 'Repeat one. Turn repeat off' };
    for (const button of all('[data-action="repeat"]')) {
      button.setAttribute('aria-pressed', String(queue.repeat !== 'off'));
      setIcon(button, queue.repeat === 'one' ? 'repeat-one' : 'repeat');
      label(button, repeatLabels[queue.repeat]);
    }
    const atEnd = queue.cursor === queue.order.length - 1 && queue.repeat !== 'all' && !queue.forwardCycles.length;
    for (const button of all('[data-action="next"]')) button.disabled = atEnd;
    $('queue-count').textContent = String(queue.order.length);
    if ($('queue-dialog').open) renderQueue();
  }
  function renderState() {
    const busy = engine.busy && engine.wanted;
    const playing = engine.status === 'playing' || engine.wanted;
    for (const button of all('[data-action="play"]')) {
      setIcon(button, busy ? 'loader' : playing ? 'pause' : 'play');
      button.classList.toggle('is-loading', busy);
      label(button, playing ? 'Pause' : 'Play');
    }
    $('playback-message').textContent = engine.message;
    $('playback-status').classList.toggle('is-error', engine.status === 'error');
    $('retry-button').hidden = engine.status !== 'error';
    $('format-label').hidden = !engine.format;
    $('format-label').textContent = engine.format === 'Opus' ? 'OPUS' : 'AAC';
    if (engine.status === 'error') $('mini-subtitle').textContent = 'Unable to load · Tap to retry';
    else if (engine.busy && engine.wanted) $('mini-subtitle').textContent = engine.message || 'Loading…';
    else $('mini-subtitle').textContent = byId.get(queue.current)?.subtitle || '';
    renderRows();
    updateTimeline();
    updateMediaPosition();
    updateAnimation();
  }
  function renderVolume() {
    const effective = audio.muted ? 0 : audio.volume;
    $('volume').value = String(Math.round(effective * 100));
    $('volume-fill').style.width = `${effective * 100}%`;
    $('volume-value').textContent = `${Math.round(effective * 100)}%`;
    $('volume').setAttribute('aria-valuetext', `${Math.round(effective * 100)} percent`);
    for (const button of all('[data-action="mute"]')) {
      setIcon(button, effective === 0 ? 'mute' : effective < .5 ? 'volume-low' : 'volume');
      label(button, effective === 0 ? 'Unmute' : 'Mute');
      button.setAttribute('aria-pressed', String(effective === 0));
    }
  }
  function toggleMute() {
    if (audio.muted || audio.volume === 0) {
      if (audio.volume === 0) engine.setVolume(lastNonzeroVolume);
      engine.setMuted(false);
    } else {
      lastNonzeroVolume = audio.volume;
      engine.setMuted(true);
    }
    renderVolume();
    saveState(true);
  }
  function updateTimeline() {
    const duration = engine.duration;
    const position = seeking ? Number($('seek').value) : engine.currentTime;
    const hasDuration = Number.isFinite(duration) && duration > 0;
    const percent = hasDuration ? clamp(position / duration * 100, 0, 100) : 0;
    $('seek').disabled = !hasDuration;
    $('seek').max = String(hasDuration ? duration : 100);
    if (!seeking) $('seek').value = String(position);
    $('seek').setAttribute('aria-valuetext', `${formatTime(position)}${hasDuration ? ` of ${formatTime(duration)}` : ''}`);
    $('elapsed').textContent = formatTime(position);
    $('duration').textContent = hasDuration ? (showRemaining ? `−${formatTime(Math.max(0, duration - position))}` : formatTime(duration)) : '—:—';
    $('progress-fill').style.width = `${percent}%`;
    $('mini-progress-fill').style.width = `${percent}%`;
    updateBuffer();
  }
  function updateBuffer() {
    let end = 0;
    const position = engine.currentTime;
    try {
      for (let i = 0; i < audio.buffered.length; i += 1) {
        // Display the buffered range containing the playhead, not an unrelated range.
        if (audio.buffered.start(i) <= position + .15 && audio.buffered.end(i) >= position) end = audio.buffered.end(i);
      }
    } catch { /* A source can change while reading TimeRanges. */ }
    const percent = Number.isFinite(engine.duration) ? clamp(end / engine.duration * 100, 0, 100) : 0;
    $('buffer-fill').style.width = `${percent}%`;
  }
  function updateAnimation() {
    cancelAnimationFrame(frame);
    frame = 0;
    if (engine.status !== 'playing' || document.hidden) return;
    const tick = () => {
      updateTimeline();
      if (engine.status === 'playing' && !document.hidden) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }
  function toggleFavorite(id) {
    if (!byId.has(id)) return;
    if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
    renderLibrary();
    updateCurrentTrack();
    saveState(true);
  }
  function selectTrack(id, context = visibleTracks.map(track => track.id)) {
    if (!byId.has(id)) return;
    seeking = false;
    queue.reset(context.includes(id) ? context : tracks.map(track => track.id), id);
    engine.load(byId.get(id), { autoplay: true });
    updateCurrentTrack();
    saveState(true);
  }
  function applyQueueResult(result, autoplay) {
    if (result.kind === 'stop') {
      engine.pause();
      engine.state('ended', 'End of queue');
    } else if (result.kind === 'restart') {
      seeking = false;
      engine.seek(0);
      if (autoplay) engine.play();
    } else {
      seeking = false;
      engine.load(byId.get(result.id), { autoplay });
      updateCurrentTrack();
    }
    renderModes();
    saveState(true);
  }
  function nextTrack(automatic = false) {
    const autoplay = automatic || engine.wanted || !audio.paused || engine.status === 'error';
    applyQueueResult(queue.next({ automatic }), autoplay);
  }
  function previousTrack() {
    const autoplay = engine.wanted || !audio.paused || engine.status === 'error';
    applyQueueResult(queue.previous(engine.currentTime), autoplay);
  }
  function renderQueue() {
    $('queue-summary').textContent = `${queue.order.length} tracks${queue.shuffle ? ' · Shuffled' : ''}${queue.repeat === 'all' ? ' · Repeat all' : queue.repeat === 'one' ? ' · Repeat one' : ''}`;
    const content = document.createDocumentFragment();
    queue.order.forEach((id, index) => {
      const track = byId.get(id);
      const li = document.createElement('li');
      li.className = `queue-row${index === queue.cursor ? ' is-current' : index < queue.cursor ? ' is-past' : ''}`;
      const button = document.createElement('button');
      button.className = 'track-main';
      button.dataset.queueIndex = String(index);
      label(button, `Play ${track.title}`);
      if (index === queue.cursor) button.setAttribute('aria-current', 'true');
      const number = document.createElement('span');
      number.className = 'queue-index';
      number.textContent = String(index + 1).padStart(2, '0');
      const copy = document.createElement('span');
      copy.className = 'track-copy';
      const title = document.createElement('span');
      title.className = 'track-title';
      title.textContent = track.title;
      const subtitle = document.createElement('span');
      subtitle.className = 'track-subtitle';
      subtitle.textContent = track.id;
      copy.append(title, subtitle);
      button.append(number, copy);
      li.append(button);
      if (index === queue.cursor) {
        const status = document.createElement('span');
        status.className = 'queue-label';
        status.textContent = 'Current';
        li.append(status);
      }
      content.append(li);
    });
    $('queue-list').replaceChildren(content);
  }
  function openDialog(id) {
    if ($(id).open) return;
    if (id === 'queue-dialog') renderQueue();
    $(id).showModal();
    if (id === 'queue-dialog') requestAnimationFrame(() => $('queue-list').querySelector('.is-current')?.scrollIntoView({ block: 'nearest' }));
  }
  function openPlayer() {
    if (desktop.matches || $('player-dialog').open) return;
    $('player-dialog').append($('player-panel'));
    $('player-dialog').showModal();
    lyrics.refreshLayout();
    updateTimeline();
  }
  function closePlayer() { if ($('player-dialog').open) $('player-dialog').close(); }
  $('player-dialog').addEventListener('close', () => { $('player-host').append($('player-panel')); lyrics.refreshLayout(); });
  desktop.addEventListener('change', () => { if (desktop.matches) closePlayer(); });
  for (const dialog of all('.sheet-dialog')) {
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
  }
  // Swipe down on the Now playing header; never intercept the seek/volume sliders.
  let headerTouch = null;
  document.querySelector('.panel-heading').addEventListener('pointerdown', event => {
    if (event.pointerType === 'touch' && !event.target.closest('button')) headerTouch = { x: event.clientX, y: event.clientY };
  });
  document.querySelector('.panel-heading').addEventListener('pointerup', event => {
    if (headerTouch && event.clientY - headerTouch.y > 65 && Math.abs(event.clientX - headerTouch.x) < 65) closePlayer();
    headerTouch = null;
  });
  document.querySelector('.panel-heading').addEventListener('pointercancel', () => { headerTouch = null; });

  const actions = {
    play: () => engine.toggle(),
    next: () => nextTrack(),
    previous: previousTrack,
    shuffle: () => { queue.setShuffle(!queue.shuffle); renderModes(); saveState(true); },
    repeat: () => { queue.cycleRepeat(); renderModes(); saveState(true); },
    mute: toggleMute,
    favorite: () => toggleFavorite(queue.current),
    queue: () => openDialog('queue-dialog'),
    downloads: () => openDialog('download-dialog'),
    shortcuts: () => openDialog('shortcuts-dialog'),
    retry: () => engine.load(byId.get(queue.current), { autoplay: true, startAt: engine.pendingSeek }),
    lyrics: () => lyrics.toggle(),
    'open-player': openPlayer,
    'close-player': closePlayer,
  };
  document.addEventListener('click', event => {
    const actionButton = event.target.closest('[data-action]');
    if (actionButton && !actionButton.disabled) { actions[actionButton.dataset.action]?.(); return; }
    const closeButton = event.target.closest('[data-close]');
    if (closeButton) { $(closeButton.dataset.close).close(); return; }
    const favoriteButton = event.target.closest('[data-favorite]');
    if (favoriteButton) { toggleFavorite(favoriteButton.dataset.favorite); return; }
    const trackButton = event.target.closest('[data-track]');
    if (trackButton) {
      if (trackButton.dataset.track === queue.current) engine.toggle();
      else selectTrack(trackButton.dataset.track);
      return;
    }
    const queueButton = event.target.closest('[data-queue-index]');
    if (queueButton) {
      const id = queue.jump(Number(queueButton.dataset.queueIndex));
      if (id) { seeking = false; engine.load(byId.get(id), { autoplay: true }); updateCurrentTrack(); renderQueue(); saveState(true); }
      return;
    }
    const filterButton = event.target.closest('[data-filter]');
    if (filterButton) {
      filter = filterButton.dataset.filter;
      renderLibrary();
      $('track-scroll').scrollTop = 0;
    }
  });
  $('search').addEventListener('input', event => { query = event.target.value; renderLibrary(); $('track-scroll').scrollTop = 0; });
  $('search-clear').addEventListener('click', () => { query = ''; $('search').value = ''; renderLibrary(); $('search').focus(); });
  $('clear-filters').addEventListener('click', () => { filter = 'all'; query = ''; $('search').value = ''; renderLibrary(); });
  $('play-all').addEventListener('click', () => { if (visibleTracks.length) selectTrack(visibleTracks[0].id); });
  $('volume').addEventListener('input', event => {
    const volume = Number(event.target.value) / 100;
    if (volume > 0) lastNonzeroVolume = volume;
    const supported = engine.setVolume(volume);
    if (!supported) { $('device-volume').hidden = false; $('volume').disabled = true; }
    renderVolume();
  });
  $('volume').addEventListener('change', () => saveState(true));
  $('speed').addEventListener('change', event => { engine.setRate(Number(event.target.value)); saveState(true); });
  $('seek').addEventListener('pointerdown', () => { seeking = true; });
  $('seek').addEventListener('input', () => { seeking = true; updateTimeline(); });
  const commitSeek = () => {
    const value = Number($('seek').value);
    seeking = false;
    engine.seek(value);
    updateTimeline();
    updateMediaPosition();
    saveState(true);
  };
  $('seek').addEventListener('change', commitSeek);
  $('seek').addEventListener('pointerup', () => { if (seeking) commitSeek(); });
  $('seek').addEventListener('pointercancel', () => { seeking = false; updateTimeline(); });
  $('seek').addEventListener('blur', () => { if (seeking) commitSeek(); });
  function updateRemainingLabel() { label($('remaining-toggle'), showRemaining ? 'Show total duration' : 'Show remaining time'); }
  $('remaining-toggle').addEventListener('click', () => { showRemaining = !showRemaining; updateRemainingLabel(); updateTimeline(); saveState(true); });
  updateRemainingLabel();

  function updateMediaMetadata(track) {
    if (!('mediaSession' in navigator) || !('MediaMetadata' in window)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: 'Sweet Times',
        album: 'Sweet Times Music',
        artwork: [192, 512].map(size => ({ src: new URL(`assets/icon-${size}.png`, document.baseURI).href, sizes: `${size}x${size}`, type: 'image/png' })),
      });
    } catch { /* Optional on browsers without complete Media Session support. */ }
  }
  function updateMediaPosition() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = engine.status === 'playing' ? 'playing' : engine.track ? 'paused' : 'none';
      if (navigator.mediaSession.setPositionState) {
        if (Number.isFinite(engine.duration)) navigator.mediaSession.setPositionState({ duration: engine.duration, playbackRate: engine.rate, position: clamp(engine.currentTime, 0, engine.duration) });
        else navigator.mediaSession.setPositionState();
      }
    } catch { /* Some platforms expose only part of the interface. */ }
  }
  if ('mediaSession' in navigator) {
    const handlers = {
      play: () => engine.play(),
      pause: () => engine.pause(),
      previoustrack: previousTrack,
      nexttrack: () => nextTrack(),
      seekbackward: details => engine.seek(engine.currentTime - (details.seekOffset || 10)),
      seekforward: details => engine.seek(engine.currentTime + (details.seekOffset || 10)),
      seekto: details => { if (Number.isFinite(details.seekTime)) engine.seek(details.seekTime); },
      stop: () => { engine.pause(); engine.seek(0); saveState(true); },
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* Unsupported action, not an app error. */ }
    }
  }
  document.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (event.target.closest('input, select, textarea, [contenteditable="true"]')) return;
    if (all('dialog[open]').some(dialog => dialog.id !== 'player-dialog')) return;
    if ((event.key === ' ' || event.key === 'Enter') && event.target.closest('button, a')) return;
    const key = event.key.toLowerCase();
    const keyboardActions = {
      ' ': actions.play, k: actions.play, n: actions.next, p: actions.previous,
      arrowleft: () => engine.seek(engine.currentTime - 5), arrowright: () => engine.seek(engine.currentTime + 5),
      j: () => engine.seek(engine.currentTime - 10), l: () => engine.seek(engine.currentTime + 10),
      arrowup: () => engine.setVolume(clamp(audio.volume + .05, 0, 1)), arrowdown: () => engine.setVolume(clamp(audio.volume - .05, 0, 1)),
      m: actions.mute, s: actions.shuffle, r: actions.repeat,
      '/': () => { closePlayer(); $('search').focus(); }, '?': actions.shortcuts,
    };
    if (keyboardActions[key]) { event.preventDefault(); if (!event.repeat || key.startsWith('arrow')) keyboardActions[key](); }
  });
  // Suppress touch callouts and pinch gestures in this app surface. Browser/OS
  // accessibility zoom can still override viewport restrictions.
  document.addEventListener('contextmenu', event => {
    if (!event.target.closest('input, textarea, [contenteditable="true"]')) event.preventDefault();
  });
  for (const eventName of ['gesturestart', 'gesturechange']) {
    document.addEventListener(eventName, event => event.preventDefault(), { passive: false });
  }
  document.addEventListener('touchmove', event => {
    if (event.touches.length > 1) event.preventDefault();
  }, { passive: false });

  engine.addEventListener('track', () => { seeking = false; updateCurrentTrack(); updateTimeline(); });
  engine.addEventListener('state', () => {
    renderState();
    saveState();
  });
  engine.addEventListener('metadata', event => {
    rememberDuration(event.detail.track.id, event.detail.duration);
    renderState();
    updateMediaPosition();
    saveState(true);
  });
  engine.addEventListener('duration', event => { rememberDuration(event.detail.track.id, event.detail.duration); updateTimeline(); });
  engine.addEventListener('time', () => {
    if (!frame) {
      cancelAnimationFrame(pendingUiFrame);
      pendingUiFrame = requestAnimationFrame(updateTimeline);
    }
    updateMediaPosition();
    saveState();
  });
  engine.addEventListener('buffer', updateBuffer);
  engine.addEventListener('volume', () => { renderVolume(); saveState(); });
  engine.addEventListener('rate', () => { $('speed').value = String(engine.rate); updateMediaPosition(); });
  engine.addEventListener('ended', () => nextTrack(true));
  document.addEventListener('visibilitychange', () => { updateAnimation(); if (document.hidden) saveState(true); else updateTimeline(); });
  window.addEventListener('pagehide', () => saveState(true));

  // Optional browser install entry point; no service worker or offline caching is registered.
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault(); deferredInstall = event; $('install-button').hidden = false;
  });
  $('install-button').addEventListener('click', async () => {
    if (!deferredInstall) return;
    try { await deferredInstall.prompt(); await deferredInstall.userChoice; }
    catch { toast('Use your browser’s install menu.'); }
    deferredInstall = null;
    $('install-button').hidden = true;
  });
  window.addEventListener('appinstalled', () => { $('install-button').hidden = true; deferredInstall = null; });
  // No service-worker registration. Live Server controls normal network loading.
  // sw.js is an unregistered, self-retiring endpoint for previous installations only.


  // Initialize paused. Theme is intentionally not restored: every new launch
  // starts from system preference; the toggle affects this page session only.
  const initialVolume = Number.isFinite(saved.volume) ? clamp(saved.volume, 0, 1) : .8;
  const softwareVolume = engine.setVolume(initialVolume === 1 ? .5 : initialVolume);
  engine.setVolume(initialVolume);
  engine.setMuted(Boolean(saved.muted));
  if (!softwareVolume) { $('volume').disabled = true; $('device-volume').hidden = false; }
  engine.setRate([.75, 1, 1.25, 1.5, 2].includes(saved.rate) ? saved.rate : 1);
  renderLibrary();
  renderVolume();
  renderModes();
  engine.load(byId.get(queue.current), { autoplay: false, startAt: Number.isFinite(saved.position) ? Math.max(0, saved.position) : 0 });
})();
