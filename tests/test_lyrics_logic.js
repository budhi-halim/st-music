/* Optional dependency-free checks: node tests/test_lyrics_logic.js */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const context = { window: {}, document: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'js/lyrics.js'), 'utf8'), context);
const { cueAt, validateRecord } = context.window.SweetTimesLyrics;
let checks = 0;
const ok = (fn) => { fn(); checks++; };
const cues = [{ index: 0, start: 1, end: 2 }, { index: 2, start: 3, end: 4 }];
for (const [time, active] of [[-1,-1],[0,-1],[1,0],[1.5,0],[2,-1],[2.9,-1],[3,2],[4,-1],[100,-1]]) {
  ok(() => assert.equal(cueAt(cues, time).active, active));
}
ok(() => assert.equal(cueAt([], 1).active, -1));
const rec = (lines) => ({ id: 'chatgpt_1a', lines });
const line = (start, end) => ({ text: 'Sweet Times', start, end });
ok(() => assert.ok(validateRecord(rec([line(null, null)]), 'chatgpt_1a')));
ok(() => assert.ok(validateRecord(rec([line(1,2),line(null,null),line(3,4)]), 'chatgpt_1a')));
ok(() => assert.equal(validateRecord(rec([line(1,2),line(1.5,3)]), 'chatgpt_1a'), null));
ok(() => assert.equal(validateRecord(rec([line(NaN,2)]), 'chatgpt_1a'), null));
ok(() => assert.equal(validateRecord(rec([line(1,Infinity)]), 'chatgpt_1a'), null));
ok(() => assert.equal(validateRecord(rec([line(1,1)]), 'chatgpt_1a'), null));
ok(() => assert.equal(validateRecord(rec([line(1,2)]), 'gemini_1a'), null));
ok(() => assert.equal(validateRecord(rec([{text:'',start:1,end:2}]), 'chatgpt_1a'), null));

(async () => {
  const handlers = {}, deleted = []; let unregistered = 0, skipped = 0;
  vm.runInNewContext(fs.readFileSync(path.join(root,'sw.js'),'utf8'), {
    self: {
      addEventListener: (name, fn) => { handlers[name] = fn; },
      skipWaiting: async () => { skipped++; },
      registration: { unregister: async () => { unregistered++; } }
    },
    caches: {
      keys: async () => ['sweet-times-music-shell-v1','unrelated-app','sweet-times-music-shell-v2'],
      delete: async key => { deleted.push(key); return true; }
    }
  });
  let work;
  handlers.install({waitUntil: promise => { work=promise; }}); await work;
  handlers.activate({waitUntil: promise => { work=promise; }}); await work;
  ok(() => assert.equal(skipped, 1));
  ok(() => assert.equal(unregistered, 1));
  ok(() => assert.deepEqual(deleted.sort(), ['sweet-times-music-shell-v1','sweet-times-music-shell-v2']));
  ok(() => assert.equal(handlers.fetch, undefined));
  const scripts = fs.readdirSync(path.join(root,'js')).filter(name=>name.endsWith('.js'));
  ok(() => assert.ok(scripts.every(name => !/serviceWorker\s*\.\s*register\s*\(/.test(fs.readFileSync(path.join(root,'js',name),'utf8')))));
  console.log(`PASS: ${checks} lyric-data and retired-worker assertions. No browser registration was performed.`);
})().catch(error => { console.error(error); process.exitCode=1; });
