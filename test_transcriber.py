"""Unit tests for speech transcription module (transcriber.py)."""
import unittest
from unittest.mock import MagicMock
import numpy as np

import transcriber
from audio_capture import RATE


class DummySegmentWord:
    def __init__(self, word, start, end):
        self.word = word
        self.start = start
        self.end = end


class DummySegment:
    def __init__(self, words):
        self.words = words


class DummyAudio:
    def __init__(self, samples=None):
        self._samples = samples if samples is not None else np.zeros(int(RATE * 3), dtype=np.float32)
        self.reset_called = False

    def latest(self, window_s):
        return self._samples

    def total_samples(self):
        return len(self._samples)

    def reset(self):
        self.reset_called = True


class TestTranscriber(unittest.TestCase):
    def setUp(self):
        self.audio = DummyAudio()
        self.received_words = []
        self.status_reports = []
        self.errors = []

        def on_words(words):
            self.received_words.extend(words)

        def on_status(status):
            self.status_reports.append(status)

        def on_error(err):
            self.errors.append(err)

        self.trans = transcriber.Transcriber(
            audio=self.audio,
            profile="fast",
            on_words=on_words,
            on_status=on_status,
            on_error=on_error,
        )

    def test_initialization_defaults(self):
        self.assertEqual(self.trans.profile, "fast")
        self.assertEqual(self.trans.model_name, "base.en")
        self.assertEqual(self.trans.tick, 0.6)
        self.assertIsNone(self.trans.aligner)

    def test_set_profile(self):
        success = self.trans.set_profile("ultrafast")
        self.assertTrue(success)
        self.assertEqual(self.trans.profile, "ultrafast")
        self.assertEqual(self.trans.model_name, "tiny.en")
        self.assertEqual(self.trans.tick, 0.4)

        invalid = self.trans.set_profile("non_existent")
        self.assertFalse(invalid)

    def test_silence_detection_and_mic_warning(self):
        self.trans.model = MagicMock()
        # Feed 3 seconds of zero amplitude audio
        self.audio._samples = np.zeros(int(RATE * 3), dtype=np.float32)

        # 3 ticks: no warning yet
        for _ in range(3):
            self.trans._tick()
        self.assertEqual(self.trans.silent_ticks, 3)
        self.assertFalse(any(s.get("mic_warning") is True for s in self.status_reports))

        # 4th tick: triggers mic warning
        self.trans._tick()
        self.assertEqual(self.trans.silent_ticks, 4)
        warnings = [s for s in self.status_reports if s.get("mic_warning") is True]
        self.assertEqual(len(warnings), 1)

        # Non-silent audio clears warning
        self.audio._samples = np.ones(int(RATE * 3), dtype=np.float32) * 0.5
        self.trans.model.transcribe.return_value = ([], None)
        self.trans._tick()
        self.assertEqual(self.trans.silent_ticks, 0)
        clear_warnings = [s for s in self.status_reports if s.get("mic_warning") is False]
        self.assertEqual(len(clear_warnings), 1)

    def test_transcribe_emits_words(self):
        # 3 seconds of active audio
        self.audio._samples = np.ones(int(RATE * 3), dtype=np.float32) * 0.5

        # Mock WhisperModel transcribe returning two words within commit window (< 2.5s)
        mock_model = MagicMock()
        mock_model.transcribe.return_value = (
            [
                DummySegment([
                    DummySegmentWord("Hello,", 0.2, 0.7),
                    DummySegmentWord("world!", 0.8, 1.4),
                ])
            ],
            None,
        )
        self.trans.model = mock_model

        self.trans._tick()
        self.assertEqual(self.received_words, ["hello", "world"])
        self.assertAlmostEqual(self.trans.committed_abs_end, 1.4, places=2)

    def test_word_near_live_edge_deferred_to_next_tick(self):
        # 3 seconds total audio: commit limit is 3.0 - 0.5 = 2.5s
        self.audio._samples = np.ones(int(RATE * 3), dtype=np.float32) * 0.5

        mock_model = MagicMock()
        mock_model.transcribe.return_value = (
            [
                DummySegment([
                    DummySegmentWord("safe", 0.5, 1.0),
                    DummySegmentWord("too_close", 2.6, 2.9),  # >= 2.5s commit limit
                ])
            ],
            None,
        )
        self.trans.model = mock_model

        self.trans._tick()
        self.assertEqual(self.received_words, ["safe"])

    def test_deduplication_of_already_committed_words(self):
        self.audio._samples = np.ones(int(RATE * 3), dtype=np.float32) * 0.5
        mock_model = MagicMock()
        self.trans.model = mock_model

        # First tick commits up to 1.5s
        mock_model.transcribe.return_value = (
            [DummySegment([DummySegmentWord("first", 0.5, 1.5)])],
            None,
        )
        self.trans._tick()
        self.assertEqual(self.received_words, ["first"])

        # Second tick Whisper produces "first" again plus "second"
        mock_model.transcribe.return_value = (
            [
                DummySegment([
                    DummySegmentWord("first", 0.5, 1.5),
                    DummySegmentWord("second", 1.6, 2.2),
                ])
            ],
            None,
        )
        self.trans._tick()
        self.assertEqual(self.received_words, ["first", "second"])

    def test_start_and_shutdown(self):
        self.trans.committed_abs_end = 5.0
        self.trans.silent_ticks = 4
        self.trans.start()
        self.assertEqual(self.trans.committed_abs_end, 0.0)
        self.assertEqual(self.trans.silent_ticks, 0)
        self.assertTrue(self.audio.reset_called)
        self.assertTrue(self.trans._running.is_set())

        self.trans.stop()
        self.assertFalse(self.trans._running.is_set())

        self.trans.shutdown()
        self.assertTrue(self.trans._stop.is_set())


if __name__ == "__main__":
    unittest.main()
