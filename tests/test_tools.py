"""Run: python -m unittest discover -s tests -v. No AI models required."""
from __future__ import annotations

from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
import json
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from common import ROOT, TRACK_IDS, Reporter, atomic_json, digest_object
from lyric_data import (PIPELINE_VERSION, parse_master, lyrics_hash, line_alignment,
                        audio_fingerprint, plain_record, valid_cache, publish)
from rename_audio import build_plan, move_no_replace
from lyrics import selected_tracks, align_all, ALIGN_OPTIONS


class TempCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'audio').mkdir()
        (self.root / 'lyrics').mkdir()
    def tearDown(self):
        self.temp.cleanup()
    def master(self, text=None):
        path = self.root / 'lyrics' / 'recordings.txt'
        if text is None:
            text = '\n\n'.join(f'=== {id} ===\n[Verse]\nGood things grow\nMade with care\n' for id in TRACK_IDS)
        path.write_text(text, encoding='utf-8')
        return path


class MasterTests(TempCase):
    def test_shipped_master_has_independent_variants(self):
        data = parse_master(ROOT / 'lyrics' / 'recordings.txt')
        self.assertEqual(list(data), list(TRACK_IDS))
        for source in ['chatgpt', 'gemini']:
            for n in range(1, 6):
                a, b = data[f'{source}_{n}a'], data[f'{source}_{n}b']
                self.assertIsNot(a, b)
        self.assertTrue(all(lines for lines in data.values()))
    def test_repeated_choruses_not_deduplicated(self):
        path = self.master('=== chatgpt_1a ===\n[Chorus]\nSing this again\n[Verse]\nAnother line\n[Chorus]\nSing this again\n')
        data = parse_master(path, require_all=False)
        self.assertEqual(sum(x['text'] == 'Sing this again' for x in data['chatgpt_1a']), 2)
    def test_comments_sections_and_bom(self):
        p = self.master('\ufeff# comment\n=== chatgpt_1a ===\n[Intro]\nHi\n# not sung\n[Outro]\nBye\n')
        data = parse_master(p, require_all=False)['chatgpt_1a']
        self.assertEqual([x['text'] for x in data], ['Hi', 'Bye'])
        self.assertEqual([x['sectionIndex'] for x in data], [1, 2])
    def test_duplicate_rejected(self):
        with self.assertRaises(ValueError):
            parse_master(self.master('=== chatgpt_1a ===\nHi\n=== chatgpt_1a ===\nBye'), False)
    def test_missing_track_rejected(self):
        with self.assertRaises(ValueError):
            parse_master(self.master('=== chatgpt_1a ===\nHi'))
    def test_unknown_id_rejected(self):
        with self.assertRaises(ValueError):
            parse_master(self.master('=== chatgpt_6a ===\nHi'), False)
    def test_inline_stage_note_rejected(self):
        with self.assertRaises(ValueError):
            parse_master(self.master('=== chatgpt_1a ===\nSweet Times (fade out)'), False)
    def test_section_inline_rejected(self):
        with self.assertRaises(ValueError):
            parse_master(self.master('=== chatgpt_1a ===\n[Chorus] Sweet Times'), False)
    def test_line_hash_not_changed_by_other_track_edits(self):
        p = self.master()
        old = parse_master(p)
        p.write_text(p.read_text().replace('Good things grow', 'A different first line\nOne more line', 1))
        new = parse_master(p)
        changed = [id for id in TRACK_IDS if lyrics_hash(old[id]) != lyrics_hash(new[id])]
        self.assertEqual(changed, ['chatgpt_1a'])
    def test_track_selection(self):
        self.assertEqual(len(selected_tracks(['gemini_*'])), 10)
        self.assertEqual(selected_tracks(['chatgpt_1a', 'chatgpt_1a']), ['chatgpt_1a'])
        with self.assertRaises(ValueError):
            selected_tracks(['unknown'])


class RenameTests(TempCase):
    def populate(self):
        for id in TRACK_IDS:
            source, code = id.split('_')
            seed = 42 if code[-1] == 'a' else 43
            for ext in ['opus', 'm4a']:
                path = self.root / 'audio' / f'sweet-times-music-{source}-{code}-preview-seed-{seed}.{ext}'
                path.write_bytes(f'unchanged audio: {id}.{ext}'.encode())
    def test_all_forty_and_content_preserved(self):
        self.populate()
        plan, errors = build_plan(self.root / 'audio')
        self.assertEqual(len(plan), 40)
        self.assertEqual(errors, [])
        for source, target in plan:
            content = source.read_bytes()
            move_no_replace(source, target)
            self.assertEqual(content, target.read_bytes())
        self.assertEqual(build_plan(self.root / 'audio'), ([], []))
    def test_existing_target_conflict(self):
        self.populate()
        target = self.root / 'audio' / 'chatgpt_1a.opus'
        target.write_bytes(b'existing')
        _, errors = build_plan(self.root / 'audio')
        self.assertTrue(any('COLLISION' in e for e in errors))
        self.assertEqual(target.read_bytes(), b'existing')
    def test_duplicate_seed_sources_conflict(self):
        self.populate()
        (self.root / 'audio' / 'sweet-times-music-chatgpt-1a-preview-seed-999.opus').write_bytes(b'other')
        _, errors = build_plan(self.root / 'audio')
        self.assertTrue(any('multiple' in e for e in errors))
    def test_never_replace_existing_bytes(self):
        a, b = self.root / 'audio' / 'a', self.root / 'audio' / 'b'
        a.write_bytes(b'A'); b.write_bytes(b'B')
        with self.assertRaises(FileExistsError):
            move_no_replace(a, b)
        self.assertEqual((a.read_bytes(), b.read_bytes()), (b'A', b'B'))
    def test_seed_does_not_choose_variant(self):
        p = self.root / 'audio' / 'sweet-times-music-gemini-2b-preview-seed-42.m4a'
        p.write_bytes(b'audio')
        plan, _ = build_plan(p.parent)
        self.assertEqual(plan[0][1].name, 'gemini_2b.m4a')
    def test_unrecognized_audio_not_renamed(self):
        (self.root / 'audio' / 'other.opus').write_bytes(b'stay')
        plan, errors = build_plan(self.root / 'audio')
        self.assertFalse(plan)
        self.assertTrue(errors[0].startswith('UNRECOGNIZED'))
    def test_preview_plan_no_mutation(self):
        self.populate()
        before = {p.name: p.read_bytes() for p in (self.root / 'audio').iterdir()}
        build_plan(self.root / 'audio')
        after = {p.name: p.read_bytes() for p in (self.root / 'audio').iterdir()}
        self.assertEqual(before, after)


class AlignmentTests(TempCase):
    def setUp(self):
        super().setUp()
        self.lines = parse_master(self.master())['chatgpt_1a']
    def segments(self):
        return [{'text': ' Good things grow', 'start': 1., 'end': 3., 'words': []},
                {'text': ' Made with care', 'start': 5., 'end': 7., 'words': []}]
    def test_gaps_preserved(self):
        result = line_alignment('chatgpt_1a', self.lines, self.segments(), 10)
        self.assertEqual(result['lines'][0]['end'], 3)
        self.assertEqual(result['lines'][1]['start'], 5)
        self.assertEqual(result['status'], 'auto')
    def test_invalid_not_evenly_interpolated(self):
        seg = self.segments(); seg[0]['start'] = seg[0]['end'] = 0
        result = line_alignment('chatgpt_1a', self.lines, seg, 10)
        self.assertIsNone(result['lines'][0]['start'])
        self.assertEqual(result['lines'][1]['start'], 5)
        self.assertEqual(result['status'], 'needs-review')
    def test_all_invalid_failure(self):
        seg = self.segments()
        for x in seg:
            x['start'] = x['end'] = 0
        with self.assertRaises(ValueError):
            line_alignment('chatgpt_1a', self.lines, seg, 10)
    def test_nonfinite_flagged(self):
        seg = self.segments(); seg[0]['start'] = float('nan')
        result = line_alignment('chatgpt_1a', self.lines, seg, 10)
        self.assertIsNone(result['lines'][0]['start'])
    def test_overlap_clipped_flagged(self):
        seg = self.segments(); seg[0]['end'] = 6
        result = line_alignment('chatgpt_1a', self.lines, seg, 10)
        self.assertEqual(result['lines'][0]['end'], 5)
        self.assertEqual(result['status'], 'needs-review')
    def test_count_and_text_mismatch_rejected(self):
        with self.assertRaises(ValueError):
            line_alignment('chatgpt_1a', self.lines, self.segments()[:1], 10)
        seg = self.segments(); seg[0]['text'] = 'Different words'
        with self.assertRaises(ValueError):
            line_alignment('chatgpt_1a', self.lines, seg, 10)
    def test_cache_invalidates_changes(self):
        p = self.root / 'audio' / 'chatgpt_1a.opus'; p.write_bytes(b'original')
        cache = {'pipelineVersion': PIPELINE_VERSION, 'lyricsHash': lyrics_hash(self.lines),
                 'audioFingerprint': audio_fingerprint(self.root, 'chatgpt_1a'),
                 'record': line_alignment('chatgpt_1a', self.lines, self.segments(), 10)}
        atomic_json(self.root / '.runtime/lyrics/alignments/chatgpt_1a.json', cache)
        self.assertIsNotNone(valid_cache(self.root, 'chatgpt_1a', self.lines))
        p.write_bytes(b'changed')
        self.assertIsNone(valid_cache(self.root, 'chatgpt_1a', self.lines))
    def test_publish_plain_without_model(self):
        data = publish(self.root, parse_master(self.root / 'lyrics/recordings.txt'))
        self.assertEqual(len(data['tracks']), 20)
        self.assertTrue(all(v['status'] == 'plain' for v in data['tracks'].values()))


class PipelineTests(TempCase):
    def test_mock_backend_alignment_publication_resume_and_single_edit(self):
        self.master()
        for id in TRACK_IDS:
            (self.root / 'audio' / f'{id}.opus').write_bytes(id.encode())
        calls = []
        class Model:
            def align(self, audio, text, **kw):
                calls.append(text)
                assert kw['original_split'] is True and kw['language'] == 'en'
                assert '[' not in text
                segments = [{'text': line, 'start': 1 + i * 3, 'end': 2 + i * 3, 'words': []}
                            for i, line in enumerate(text.splitlines())]
                kw['progress_callback'](10, 10)
                return SimpleNamespace(to_dict=lambda: {'segments': segments})
        stable = SimpleNamespace(load_model=lambda *a, **kw: Model())
        torch = SimpleNamespace(set_num_threads=lambda x: None, inference_mode=nullcontext)
        fake_audio = range(160000)  # Only len() is used outside the fake backend.
        args = SimpleNamespace(track=None, model='medium.en', force=False, device='cpu', threads=4, vocals_dir=None)
        with patch('lyrics.find_ffmpeg', return_value='ffmpeg'), \
             patch('lyrics.dependencies', return_value=(stable, torch, 'cpu')), \
             patch('lyrics.decode_audio', return_value=fake_audio):
            with Reporter(self.root, 'test') as report:
                self.assertEqual(align_all(self.root, args, report), 0)
                self.assertEqual(len(calls), 20)
                self.assertEqual(align_all(self.root, args, report), 0)
                self.assertEqual(len(calls), 20)
                path = self.root / 'lyrics/recordings.txt'
                path.write_text(path.read_text().replace('Good things grow', 'The first line changed', 1))
                self.assertEqual(align_all(self.root, args, report), 0)
                self.assertEqual(len(calls), 21)
                self.assertTrue(calls[-1].startswith('The first line changed'))
        data = json.loads((self.root / 'data/lyrics.json').read_text())
        self.assertTrue(all(v['status'] == 'auto' for v in data['tracks'].values()))
        self.assertTrue((self.root / '.runtime/lyrics/review.txt').is_file())


if __name__ == '__main__':
    unittest.main()
