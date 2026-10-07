/* Edit display names here if needed. Keep each id/file stem unchanged. */
(() => {
  'use strict';
  const tracks = [];
  for (const source of ['chatgpt', 'gemini']) {
    for (let prompt = 1; prompt <= 5; prompt += 1) {
      for (const variant of ['a', 'b']) {
        const id = `${source}_${prompt}${variant}`;
        const sourceName = source === 'chatgpt' ? 'ChatGPT' : 'Gemini';
        tracks.push(Object.freeze({
          id,
          title: `${sourceName} ${prompt}${variant.toUpperCase()}`,
          source,
          sourceName,
          prompt,
          variant,
          subtitle: `Prompt ${prompt} · Version ${variant.toUpperCase()}`,
          sources: Object.freeze([
            { url: `audio/${id}.opus`, type: 'audio/ogg; codecs="opus"', label: 'Opus' },
            { url: `audio/${id}.m4a`, type: 'audio/mp4; codecs="mp4a.40.2"', label: 'AAC' },
          ]),
        }));
      }
    }
  }
  window.SweetTimesTracks = Object.freeze(tracks);
})();
