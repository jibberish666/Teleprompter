"""Unit tests for the PrompterSession coordinator (session.py)."""
import json
import unittest
from unittest.mock import MagicMock, patch

from session import PrompterSession, SessionState


class DummyAudioSource:
    """Mock audio source for fast testing without hardware sound cards."""

    def __init__(self, device=None, browser_audio=False, on_level=None):
        self.device = device
        self.is_browser = browser_audio
        self.on_level = on_level
        self.active_device_id = device if device is not None else ("browser" if browser_audio else 0)
        self.started = False
        self.stopped = False
        self.ingested = []

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True

    def reset(self):
        self.ingested.clear()

    def set_device(self, dev):
        self.active_device_id = dev
        self.is_browser = str(dev).strip().lower() == "browser"

    def get_devices(self):
        return [
            {"id": "browser", "name": "Browser Microphone (Live WebRTC · Recommended)", "is_browser": True},
            {"id": 0, "name": "Built-in Microphone", "is_browser": False},
        ]

    def ingest_frames(self, data):
        self.ingested.append(data)


class DummyAligner:
    """Mock aligner to test fumble collection and seeking."""

    def __init__(self, words, window=5, tolerance=5):
        self.words = words
        self.window = window
        self.tolerance = tolerance
        self.current_idx = 0
        self.fumbles = [{"word": "the", "clean": "the", "type": "repeated"}]

    def seek(self, idx):
        self.current_idx = idx

    def get_all_fumbles(self):
        return list(self.fumbles)


class DummyTranscriber:
    """Mock transcriber for fast deterministic session testing."""

    def __init__(self, audio, profile="fast", **kwargs):
        self.audio = audio
        self.profile = profile
        self.model_name = "base.en"
        self.tick = 0.6
        self.is_ready = True
        self.is_rehearsal = False
        self.aligner = None
        self.started_async = False
        self.started_loop = False
        self.shutdown_called = False
        self.stopped_called = False
        self.on_sync = kwargs.get("on_sync")
        self.on_status = kwargs.get("on_status")
        self.on_error = kwargs.get("on_error")
        self.on_fumble = kwargs.get("on_fumble")

    def start_loading_async(self):
        self.started_async = True

    def start_loop(self):
        self.started_loop = True

    def shutdown(self):
        self.shutdown_called = True

    def begin(self, words, is_rehearsal=False):
        self.is_rehearsal = bool(is_rehearsal)
        self.aligner = DummyAligner(words)

    def stop(self):
        self.stopped_called = True

    def seek(self, idx):
        if self.aligner:
            self.aligner.seek(idx)

    def set_profile(self, mode):
        self.profile = mode
        return True


class TestPrompterSession(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.config_saves = []

        def event_sink(payload):
            self.events.append(payload)

        def config_saver(**kwargs):
            self.config_saves.append(kwargs)

        self.audio = DummyAudioSource()
        self.trans = DummyTranscriber(audio=self.audio)
        self.session = PrompterSession(
            event_sink=event_sink,
            on_config_save=config_saver,
            audio_source=self.audio,
            trans=self.trans,
            host="127.0.0.1",
            port=8000,
        )

    def test_initial_state_and_payloads(self):
        self.assertEqual(self.session.state, SessionState.IDLE)
        self.assertFalse(self.session.is_running)
        self.assertTrue(self.session.is_ready)
        self.assertEqual(self.session.profile, "fast")
        self.assertEqual(self.session.model_name, "base.en")
        self.assertFalse(self.session.is_browser_audio)

        initial = self.session.get_initial_messages()
        self.assertEqual(len(initial), 2)
        self.assertEqual(initial[0]["type"], "config")
        self.assertEqual(initial[1]["type"], "status")
        self.assertEqual(initial[0]["active_audio_device"], 0)

    def test_lifecycle_start_and_shutdown(self):
        self.session.start()
        self.assertTrue(self.audio.started)
        self.assertTrue(self.trans.started_async)
        self.assertTrue(self.trans.started_loop)

        self.session.shutdown()
        self.assertTrue(self.trans.shutdown_called)
        self.assertTrue(self.audio.stopped)

    def test_start_session_validation_not_ready(self):
        self.trans.is_ready = False
        res = self.session.start_session(["hello", "world"])
        self.assertFalse(res)
        self.assertEqual(self.events[-1]["type"], "error")
        self.assertIn("loading", self.events[-1]["message"])

    def test_start_session_validation_empty_words(self):
        self.trans.is_ready = True
        res = self.session.start_session([])
        self.assertFalse(res)
        self.assertEqual(self.events[-1]["type"], "error")
        self.assertIn("No transcript", self.events[-1]["message"])

    def test_start_session_running(self):
        res = self.session.start_session(["sample", "script", "text"], rehearsal=False)
        self.assertTrue(res)
        self.assertEqual(self.session.state, SessionState.RUNNING)
        self.assertTrue(self.session.is_running)
        self.assertFalse(self.session.is_rehearsal)

        status_event = self.events[-1]
        self.assertEqual(status_event["type"], "status")
        self.assertEqual(status_event["state"], "running")
        self.assertTrue(status_event["running"])
        self.assertFalse(status_event["rehearsal"])

    def test_start_session_rehearsal(self):
        res = self.session.start_session(["sample", "script"], rehearsal=True)
        self.assertTrue(res)
        self.assertEqual(self.session.state, SessionState.REHEARSING)
        self.assertTrue(self.session.is_rehearsal)

        status_event = self.events[-1]
        self.assertEqual(status_event["type"], "status")
        self.assertEqual(status_event["state"], "running")
        self.assertTrue(status_event["running"])
        self.assertTrue(status_event["rehearsal"])

    def test_start_session_with_audio_device(self):
        self.session.start_session(["hello"], audio_device=1)
        self.assertEqual(self.audio.active_device_id, 1)
        self.assertEqual(self.config_saves[-1], {"mic": "1"})

    def test_stop_session_regular(self):
        self.session.start_session(["word1", "word2"], rehearsal=False)
        self.session.stop_session()
        self.assertEqual(self.session.state, SessionState.STOPPED)
        self.assertTrue(self.trans.stopped_called)

        # Because dummy aligner had fumbles, rehearsal_summary is emitted
        summary_events = [e for e in self.events if e["type"] == "rehearsal_summary"]
        self.assertEqual(len(summary_events), 1)

    def test_stop_session_rehearsal_summary(self):
        self.session.start_session(["word1", "word2"], rehearsal=True)
        self.session.stop_session()
        self.assertEqual(self.session.state, SessionState.STOPPED)

        status_events = [e for e in self.events if e.get("state") == "stopped"]
        self.assertTrue(len(status_events) > 0)
        self.assertTrue(status_events[-1]["rehearsal"])

        summary_events = [e for e in self.events if e["type"] == "rehearsal_summary"]
        self.assertEqual(len(summary_events), 1)
        self.assertEqual(len(summary_events[0]["fumbles"]), 1)

    def test_seek(self):
        self.session.start_session(["alpha", "beta", "gamma"])
        self.session.seek(2)
        self.assertEqual(self.trans.aligner.current_idx, 2)

    def test_set_engine(self):
        success = self.session.set_engine("ultrafast")
        self.assertTrue(success)
        self.assertEqual(self.trans.profile, "ultrafast")

    def test_set_audio_device_and_persistence(self):
        self.session.set_audio_device("browser")
        self.assertTrue(self.session.is_browser_audio)
        self.assertEqual(self.config_saves[-1], {"mic": "browser"})
        self.assertEqual(self.events[-1]["type"], "audio_device_changed")
        self.assertEqual(self.events[-1]["device"], "browser")
        self.assertTrue(self.events[-1]["is_browser"])

    def test_refresh_audio_devices(self):
        self.session.refresh_audio_devices()
        self.assertEqual(self.events[-1]["type"], "config")
        self.assertIn("audio_devices", self.events[-1])

    def test_ingest_audio_frames(self):
        sample_pcm = [0.1, -0.2, 0.3]
        self.session.ingest_audio_frames(sample_pcm)
        self.assertIn(sample_pcm, self.audio.ingested)

    def test_status_enrichment(self):
        # When transcriber emits ready status, PrompterSession enriches with host/port/browser_audio
        self.session._on_status({"ready": True, "model": "base.en"})
        enriched = self.events[-1]
        self.assertEqual(enriched["type"], "status")
        self.assertTrue(enriched["ready"])
        self.assertFalse(enriched["browser_audio"])
        self.assertEqual(enriched["host"], "127.0.0.1")
        self.assertEqual(enriched["port"], 8000)

    def test_dispatch_json_string_and_dict(self):
        # Test JSON string dispatch
        msg_str = json.dumps({"type": "set_engine", "mode": "standard"})
        self.session.dispatch(msg_str)
        self.assertEqual(self.trans.profile, "standard")

        # Test dictionary dispatch
        self.session.dispatch({"type": "seek", "word_index": 5})
        # If aligner exists, seek is routed
        self.session.start_session(["a", "b", "c"])
        self.session.dispatch({"type": "seek", "word_index": 1})
        self.assertEqual(self.trans.aligner.current_idx, 1)

        # Test audio dispatch
        self.session.dispatch({"type": "audio", "data": [0.05, 0.05]})
        self.assertEqual(self.audio.ingested[-1], [0.05, 0.05])

        # Test invalid JSON string does not crash
        self.session.dispatch("invalid json {{{")

    def test_rehearsal_observer_lifecycle_and_summary(self):
        self.session.start_session(["alpha", "beta", "gamma"], rehearsal=True)
        self.assertIsNotNone(self.session.rehearsal_observer)
        self.assertEqual(self.session.rehearsal_observer.raw_words, ["alpha", "beta", "gamma"])

        # Manually record fumble on observer
        self.session.rehearsal_observer.record_fumble(1, "skipped")
        self.assertEqual(len(self.session.rehearsal_observer.get_all_fumbles()), 1)

        self.session.stop_session()
        summary_events = [e for e in self.events if e["type"] == "rehearsal_summary"]
        self.assertEqual(len(summary_events), 1)
        self.assertEqual(summary_events[0]["fumbles"][0]["clean"], "beta")
        self.assertEqual(summary_events[0]["fumbles"][0]["reason"], "skipped")

    def test_on_words_alignment_and_sync_emission(self):
        self.session.start_session(["hello", "world", "this", "is", "a", "test"])
        self.session._on_words(["hello", "world"])
        sync_events = [e for e in self.events if e.get("type") == "sync"]
        self.assertEqual(len(sync_events), 2)
        self.assertEqual(sync_events[0]["word_index"], 0)
        self.assertEqual(sync_events[1]["word_index"], 1)
        self.assertEqual(self.session.aligner.cursor, 2)

    def test_on_words_ignored_when_stopped(self):
        self.session.start_session(["hello", "world"])
        self.session.stop_session()
        event_count_before = len(self.events)
        self.session._on_words(["hello"])
        self.assertEqual(len(self.events), event_count_before)

    def test_session_owns_aligner_directly(self):
        self.session.start_session(["one", "two", "three"])
        self.assertIsNotNone(self.session.aligner)
        self.assertEqual(self.session.aligner.cursor, 0)
        self.session.seek(2)
        self.assertEqual(self.session.aligner.cursor, 2)

    def test_patch_config_updates_and_emits(self):
        self.session.patch_config("ui", {"box_width_pct": 77, "difficult_style": "glow"})
        self.assertEqual(self.session.cfg["ui"]["box_width_pct"], 77)
        self.assertEqual(self.session.cfg["ui"]["difficult_style"], "glow")
        update_events = [e for e in self.events if e.get("type") == "config_updated"]
        self.assertTrue(len(update_events) > 0)
        last_evt = update_events[-1]
        self.assertEqual(last_evt["domain"], "ui")
        self.assertEqual(last_evt["data"]["box_width_pct"], 77)

    def test_dispatch_config_patch(self):
        self.session.dispatch(json.dumps({
            "type": "config_patch",
            "domain": "recording",
            "data": {"mode": "audio", "audio_format": "wav"}
        }))
        self.assertEqual(self.session.cfg["recording"]["mode"], "audio")
        self.assertEqual(self.session.cfg["recording"]["audio_format"], "wav")

    def test_dispatch_save_take(self):
        import base64
        import os
        import shutil

        dummy_content = b"TELEPROMPTER_TEST_TAKE_DATA"
        dummy_b64 = base64.b64encode(dummy_content).decode("ascii")
        self.session.dispatch(json.dumps({
            "type": "save_take",
            "filename": "unit_test_take.webm",
            "data": dummy_b64
        }))

        saved_events = [e for e in self.events if e.get("type") == "take_saved"]
        self.assertEqual(len(saved_events), 1)
        self.assertTrue(saved_events[0]["success"])
        self.assertEqual(saved_events[0]["filename"], "unit_test_take.webm")
        saved_path = saved_events[0]["path"]
        self.assertTrue(os.path.isfile(saved_path))
        with open(saved_path, "rb") as f:
            self.assertEqual(f.read(), dummy_content)
        # Clean up unit test artifact
        try:
            os.remove(saved_path)
        except OSError:
            pass


if __name__ == "__main__":
    unittest.main()

