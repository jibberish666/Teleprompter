"""Unit and integration tests for teleprompter alignment engine (aligner.py)."""
import os
import unittest

import aligner


class TestNormalization(unittest.TestCase):
    def test_normalize_basic(self):
        self.assertEqual(aligner.normalize("Hello"), "hello")
        self.assertEqual(aligner.normalize("WORLD!"), "world")
        self.assertEqual(aligner.normalize("  spaces  "), "spaces")
        self.assertEqual(aligner.normalize(""), "")
        self.assertEqual(aligner.normalize(None), "")

    def test_normalize_punctuation_and_contractions(self):
        self.assertEqual(aligner.normalize("don't"), "dont")
        self.assertEqual(aligner.normalize("high-speed"), "highspeed")
        self.assertEqual(aligner.normalize("VSR3,"), "vsr3")
        self.assertEqual(aligner.normalize("end."), "end")
        self.assertEqual(aligner.normalize('"quoted"'), "quoted")


class TestSimilarity(unittest.TestCase):
    def test_exact_match(self):
        self.assertEqual(aligner._similarity("test", "test"), 1.0)
        self.assertEqual(aligner._similarity("a", "a"), 1.0)
        self.assertEqual(aligner._similarity("", "test"), 0.0)

    def test_short_words_strict_exact(self):
        # Short words (<= 3 chars) must never match prefix or fuzzy
        self.assertEqual(aligner._similarity("the", "these"), 0.0)
        self.assertEqual(aligner._similarity("the", "there"), 0.0)
        self.assertEqual(aligner._similarity("car", "careful"), 0.0)
        self.assertEqual(aligner._similarity("to", "so"), 0.0)
        self.assertEqual(aligner._similarity("in", "on"), 0.0)
        self.assertEqual(aligner._similarity("you", "your"), 0.0)
        self.assertEqual(aligner._similarity("for", "from"), 0.0)
        self.assertEqual(aligner._similarity("and", "an"), 0.0)
        self.assertEqual(aligner._similarity("our", "ourselves"), 0.0)

    def test_stem_and_inflections(self):
        self.assertGreaterEqual(aligner._similarity("balance", "balancing"), 0.75)
        self.assertGreaterEqual(aligner._similarity("assembly", "assemblies"), 0.75)
        self.assertGreaterEqual(aligner._similarity("technics", "techniques"), 0.75)
        self.assertGreaterEqual(aligner._similarity("accelerates", "accelerating"), 0.75)
        self.assertGreaterEqual(aligner._similarity("operate", "operating"), 0.75)
        self.assertGreaterEqual(aligner._similarity("component", "components"), 0.75)
        self.assertGreaterEqual(aligner._similarity("speed", "speeds"), 0.75)

    def test_distinct_words_rejected(self):
        self.assertEqual(aligner._similarity("turbocharger", "supercharger"), 0.0)
        self.assertEqual(aligner._similarity("rotor", "motor"), 0.0)
        self.assertEqual(aligner._similarity("with", "which"), 0.0)


class TestAligner(unittest.TestCase):
    def setUp(self):
        self.script_text = (
            "Today I'm going to give you a quick technical overview of the Turbo Technics VSR3, "
            "our high-speed balancing machine designed primarily for passenger car and light commercial "
            "turbocharger core assemblies. VSR stands for vibration sort rig and like a conventional "
            "component balancing machine the VSR tests the complete centre housing rotating assembly "
            "or CHRA at speeds approaching those it would experience in service."
        )
        self.words = self.script_text.split()
        self.aligner = aligner.Aligner(self.words, window=5, max_lookahead=25, tolerance=5)

    def test_sequential_matching(self):
        # First 4 words
        matched = self.aligner.align(["today", "im"])
        self.assertEqual(matched, [0, 1])
        self.assertEqual(self.aligner.cursor, 2)

        matched2 = self.aligner.align(["going", "to"])
        self.assertEqual(matched2, [2, 3])
        self.assertEqual(self.aligner.cursor, 4)

    def test_rejection_of_single_word_false_positive_in_lookahead(self):
        self.aligner.seek(4)  # At word 'give' (index 4)
        self.assertEqual(self.aligner.cursor, 4)

        # Words appearing later in script:
        # 'our' is at index 15
        # 'machine' is at index 18
        # 'car' is at index 23
        # 'assemblies' is at index 29
        # None of these should match when given as isolated single tokens
        self.assertEqual(self.aligner.align(["our"]), [])
        self.assertEqual(self.aligner.cursor, 4)

        self.assertEqual(self.aligner.align(["machine"]), [])
        self.assertEqual(self.aligner.cursor, 4)

        self.assertEqual(self.aligner.align(["car"]), [])
        self.assertEqual(self.aligner.cursor, 4)

        self.assertEqual(self.aligner.align(["assemblies"]), [])
        self.assertEqual(self.aligner.cursor, 4)

        # Now when the genuine next words are spoken, tracking resumes normally
        matched = self.aligner.align(["give", "you"])
        self.assertEqual(matched, [4, 5])
        self.assertEqual(self.aligner.cursor, 6)

    def test_ad_libs_and_filler_words(self):
        self.aligner.seek(4)  # At 'give'
        # Speaker says "give, uh, our, quick" -> 'uh' and 'our' should not cause distant leap
        matched = self.aligner.align(["give", "uh", "our", "quick"])
        # 'give' is index 4, 'quick' is index 7 (within local window 5 of cursor 5)
        self.assertEqual(matched, [4, 7])
        self.assertEqual(self.aligner.cursor, 8)

    def test_mandatory_multi_word_confirmation_for_jumps(self):
        self.aligner.seek(4)  # At 'give'
        # Speaker intentionally skips ahead to "balancing machine" (indices 17, 18)
        matched = self.aligner.align(["balancing", "machine"])
        self.assertEqual(matched, [17, 18])
        self.assertEqual(self.aligner.cursor, 19)

    def test_short_words_require_3_words_for_jump(self):
        self.aligner.seek(4)  # At 'give'
        # "for passenger" (index 21, 22) - 'for' (3 chars) + 'passenger' (9 chars) = 12 chars >= 7 -> accepted
        matched = self.aligner.align(["for", "passenger"])
        self.assertEqual(matched, [21, 22])
        self.assertEqual(self.aligner.cursor, 23)

    def test_compound_words_split_asr(self):
        # Script has "high-speed" (normalized to "highspeed" at index 16)
        self.aligner.seek(16)
        matched = self.aligner.align(["high", "speed"])
        self.assertEqual(matched, [16])
        self.assertEqual(self.aligner.cursor, 17)

    def test_compound_words_split_script(self):
        # If script had "turbo" "charger" and ASR emitted "turbocharger"
        script = ["light", "commercial", "turbo", "charger", "core"]
        al = aligner.Aligner(script, window=5)
        al.seek(2)
        matched = al.align(["turbocharger"])
        self.assertEqual(matched, [2, 3])
        self.assertEqual(al.cursor, 4)

    def test_manual_seek_resets_streak(self):
        self.aligner.streak = 10
        self.assertTrue(self.aligner.paused)
        self.aligner.seek(10)
        self.assertEqual(self.aligner.cursor, 10)
        self.assertEqual(self.aligner.streak, 0)
        self.assertFalse(self.aligner.paused)

    def test_technical_numbers_and_terms(self):
        script = "operate at speeds up to 300000 revolutions per minute with impeller tip speeds up to 550 metres per second".split()
        al = aligner.Aligner(script, window=5)
        matched = al.align(["operate", "at", "speeds", "up", "to", "300000", "revolutions"])
        self.assertEqual(matched, [0, 1, 2, 3, 4, 5, 6])
        self.assertEqual(al.cursor, 7)

    def test_long_ad_lib_interruption_then_resume(self):
        # Cursor is at 4 ('give')
        self.aligner.seek(4)
        # Speaker goes off-script with 6 ad-lib words that don't match upcoming script
        matched1 = self.aligner.align(["let", "me", "think", "about", "what", "else"])
        self.assertEqual(matched1, [])
        self.assertEqual(self.aligner.cursor, 4)
        self.assertTrue(self.aligner.paused)

        # Speaker resumes script: "give you a quick"
        matched2 = self.aligner.align(["give", "you", "a", "quick"])
        self.assertEqual(matched2, [4, 5, 6, 7])
        self.assertEqual(self.aligner.cursor, 8)
        self.assertFalse(self.aligner.paused)

    def test_backward_seek(self):
        self.aligner.seek(20)
        self.assertEqual(self.aligner.cursor, 20)
        # Speaker jumps back to index 0
        self.aligner.seek(0)
        self.assertEqual(self.aligner.cursor, 0)
        matched = self.aligner.align(["today", "im"])
        self.assertEqual(matched, [0, 1])
        self.assertEqual(self.aligner.cursor, 2)


class TestRealSessionPlayback(unittest.TestCase):
    def test_all_webm_recordings(self):
        # Run Whisper transcription simulation across all webm recordings in repo
        webm_files = [
            f for f in sorted(os.listdir("."))
            if f.endswith(".webm") and os.path.isfile(f)
        ]
        if not webm_files:
            self.skipTest("No .webm session files found in workspace.")

        from faster_whisper import WhisperModel
        model = WhisperModel("base.en", device="cpu", compute_type="int8")

        for fname in webm_files:
            with self.subTest(file=fname):
                segments, _ = model.transcribe(fname, beam_size=1, word_timestamps=True)
                raw_words = []
                for s in segments:
                    for w in (s.words or []):
                        raw_words.append(w.word.strip())

                self.assertGreater(len(raw_words), 0, f"No words extracted from {fname}")

                script_words = list(raw_words)
                norm_asr = [aligner.normalize(w) for w in raw_words]

                al = aligner.Aligner(script_words, window=5)
                all_matched = []
                # Simulate live streaming in chunks of 2 words
                for idx in range(0, len(norm_asr), 2):
                    chunk = norm_asr[idx : idx + 2]
                    m = al.align(chunk)
                    all_matched.extend(m)

                coverage = len(all_matched) / len(script_words) * 100
                self.assertGreaterEqual(
                    coverage,
                    98.0,
                    f"{fname}: coverage {coverage:.1f}% was below 98%",
                )
                self.assertEqual(
                    al.cursor,
                    len(script_words),
                    f"{fname}: final cursor did not reach script end",
                )


if __name__ == "__main__":
    unittest.main()
