"""Unit tests for Unified Audio Ingestion Boundary (AudioSource in audio_capture.py)."""
import time
import unittest
from unittest.mock import MagicMock, patch

import numpy as np

import audio_capture
from audio_capture import RATE, AudioCapture, AudioSource, RingBuffer


class TestRingBuffer(unittest.TestCase):
    def test_empty_buffer(self):
        buf = RingBuffer(capacity_seconds=1.0)
        self.assertEqual(buf.total_samples, 0)
        samples = buf.latest(0.5)
        self.assertEqual(len(samples), 0)

    def test_write_and_read(self):
        buf = RingBuffer(capacity_seconds=1.0)
        data = np.ones(1600, dtype=np.float32) * 0.5
        buf.write(data)
        self.assertEqual(buf.total_samples, 1600)
        latest = buf.latest(0.1)
        self.assertEqual(len(latest), 1600)
        self.assertTrue(np.allclose(latest, 0.5))

    def test_overflow_wraparound(self):
        buf = RingBuffer(capacity_seconds=0.1)  # 1600 samples
        data1 = np.ones(1000, dtype=np.float32) * 0.1
        data2 = np.ones(1000, dtype=np.float32) * 0.9
        buf.write(data1)
        buf.write(data2)
        self.assertEqual(buf.total_samples, 2000)
        latest = buf.latest(0.1)
        self.assertEqual(len(latest), 1600)
        # The oldest 400 from data1 remain at start, followed by all 1000 of data2
        self.assertTrue(np.allclose(latest[:600], 0.1))
        self.assertTrue(np.allclose(latest[600:], 0.9))


class TestAudioSource(unittest.TestCase):
    def test_backwards_compatibility_alias(self):
        self.assertIs(AudioCapture, AudioSource)

    def test_initialization_browser_mode(self):
        src = AudioSource(browser_audio=True)
        self.assertTrue(src.is_browser)
        self.assertTrue(src.browser_audio)
        self.assertEqual(src.active_device_id, "browser")
        self.assertEqual(src.device, "browser")

    def test_initialization_browser_device_string(self):
        src = AudioSource(device="browser")
        self.assertTrue(src.is_browser)
        self.assertEqual(src.active_device_id, "browser")

    def test_query_devices_contains_browser_first(self):
        devices = AudioSource.query_devices()
        self.assertGreater(len(devices), 0)
        self.assertEqual(devices[0]["id"], "browser")
        self.assertIn("Browser Microphone", devices[0]["name"])

    def test_resolve_device(self):
        self.assertIsNone(AudioSource.resolve_device(None))
        self.assertEqual(AudioSource.resolve_device("browser"), "browser")
        self.assertEqual(AudioSource.resolve_device("2"), 2)
        self.assertEqual(AudioSource.resolve_device(3), 3)

    def test_ingest_frames_list_and_numpy(self):
        src = AudioSource(browser_audio=True)
        # Test python list ingestion
        data_list = [0.1] * 1600
        src.ingest_frames(data_list)
        self.assertEqual(src.total_samples(), 1600)

        # Test numpy array ingestion
        data_arr = np.ones(1600, dtype=np.float32) * 0.2
        src.ingest_frames(data_arr)
        self.assertEqual(src.total_samples(), 3200)

        latest = src.latest(0.2)
        self.assertEqual(len(latest), 3200)
        self.assertTrue(np.allclose(latest[:1600], 0.1))
        self.assertTrue(np.allclose(latest[1600:], 0.2))

    def test_ingest_frames_auto_transitions_to_browser(self):
        src = AudioSource(device=0, browser_audio=False)
        self.assertFalse(src.is_browser)
        src.ingest_frames([0.0] * 100)
        self.assertTrue(src.is_browser)
        self.assertEqual(src.active_device_id, "browser")

    def test_vu_metering_and_throttling(self):
        levels_received = []

        def on_level(level, device):
            levels_received.append((level, device))

        src = AudioSource(browser_audio=True, on_level=on_level, vu_interval=0.05)

        # Send test wave with known amplitude
        wave = [0.2] * 1600
        src.ingest_frames(wave)
        self.assertEqual(len(levels_received), 1)
        lvl, dev = levels_received[0]
        self.assertEqual(dev, "browser")
        self.assertGreater(lvl, 0)

        # Immediate follow-up frame within throttle window should be suppressed
        src.ingest_frames(wave)
        self.assertEqual(len(levels_received), 1)

        # Wait past throttle interval
        time.sleep(0.06)
        src.ingest_frames(wave)
        self.assertEqual(len(levels_received), 2)

    def test_dynamic_device_switching(self):
        src = AudioSource(browser_audio=True)
        self.assertTrue(src.is_browser)

        # Switch to hardware device (simulated index 1)
        with patch("sounddevice.InputStream") as mock_stream_cls:
            mock_stream = MagicMock()
            mock_stream_cls.return_value = mock_stream
            src.start()
            src.set_device(1)

            self.assertFalse(src.is_browser)
            self.assertEqual(src.active_device_id, "1")

            # Switch back to browser
            src.set_device("browser")
            self.assertTrue(src.is_browser)
            self.assertEqual(src.active_device_id, "browser")

    def test_reset(self):
        src = AudioSource(browser_audio=True)
        src.ingest_frames([0.5] * 1600)
        self.assertEqual(src.total_samples(), 1600)
        src.reset()
        self.assertEqual(src.total_samples(), 0)
        self.assertEqual(len(src.latest(1.0)), 0)


if __name__ == "__main__":
    unittest.main()
