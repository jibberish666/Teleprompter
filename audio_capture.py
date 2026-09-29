"""16kHz mono float32 microphone capture into a thread-safe ring buffer.

Unified Audio Ingestion Boundary (AudioSource):
Encapsulates all audio acquisition mechanics:
- Hardware microphone stream lifecycle (sounddevice.InputStream)
- Browser audio WebRTC PCM frame ingestion
- Audio device enumeration, hot-plug refresh, and name resolution
- Real-time VU level calculation and throttling
- Thread-safe rolling ring buffer
"""
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Union

import numpy as np
import sounddevice as sd

RATE = 16000


class RingBuffer:
    """A fixed-capacity float32 sample buffer.

    Both the sounddevice callback thread and the browser audio WebSocket handler
    write into this buffer using the same interface, so the transcriber sees a
    single continuous stream regardless of source.
    """

    def __init__(self, capacity_seconds: float = 8.0):
        self.cap = int(capacity_seconds * RATE)
        self.data = np.zeros(self.cap, dtype=np.float32)
        self.pos = 0
        self.total = 0
        self.lock = threading.Lock()

    def write(self, samples):
        if samples is None or len(samples) == 0:
            return
        samples = np.asarray(samples, dtype=np.float32).reshape(-1)
        n = len(samples)
        with self.lock:
            if n >= self.cap:
                self.data[:] = samples[-self.cap:]
                self.pos = 0
                self.total += n
                return
            idx = self.pos
            if idx + n <= self.cap:
                self.data[idx:idx + n] = samples
            else:
                first = self.cap - idx
                self.data[idx:] = samples[:first]
                self.data[:n - first] = samples[first:]
            self.pos = (idx + n) % self.cap
            self.total += n

    def latest(self, seconds: float) -> np.ndarray:
        n = int(seconds * RATE)
        with self.lock:
            if n <= 0:
                return np.zeros(0, dtype=np.float32)
            n = min(n, self.total)
            if n <= 0:
                return np.zeros(0, dtype=np.float32)
            idx = (self.pos - n) % self.cap
            if idx + n <= self.cap:
                return self.data[idx:idx + n].copy()
            out = np.empty(n, dtype=np.float32)
            first = self.cap - idx
            out[:first] = self.data[idx:]
            out[first:] = self.data[:n - first]
            return out

    @property
    def total_samples(self) -> int:
        with self.lock:
            return self.total


class AudioSource:
    """Unified audio acquisition module.

    Encapsulates hardware sounddevice stream lifecycle, browser WebRTC PCM stream
    ingestion, device querying/reloading, and throttled VU metering.
    """

    def __init__(
        self,
        device: Optional[Union[str, int]] = None,
        browser_audio: bool = False,
        rate: int = RATE,
        on_level: Optional[Callable] = None,
        vu_interval: float = 0.06,
        mic: Optional[Union[str, int]] = None,
    ):
        if device is None and mic is not None:
            device = mic

        self.rate = rate
        self.buffer = RingBuffer()
        self.stream = None
        self.on_level = on_level
        self.vu_interval = vu_interval
        self._last_vu_time = 0.0
        self._vu_lock = threading.Lock()
        self._started = False

        # Audio source state
        self._is_browser = browser_audio or (str(device).lower() == "browser" if device is not None else False)
        self._raw_device = device if not self._is_browser else None
        self._resolved_device = self.resolve_device(self._raw_device) if not self._is_browser else None

    @property
    def is_browser(self) -> bool:
        return self._is_browser

    @property
    def browser_audio(self) -> bool:
        """Backwards compatibility alias for is_browser."""
        return self._is_browser

    @browser_audio.setter
    def browser_audio(self, value: bool):
        self._is_browser = bool(value)
        if self._is_browser:
            self._raw_device = None
            self._resolved_device = None

    @property
    def device(self):
        """Active device identifier or raw requested device."""
        if self._is_browser:
            return "browser"
        return self._resolved_device if self._resolved_device is not None else self._raw_device

    @property
    def active_device_id(self) -> str:
        if self._is_browser:
            return "browser"
        if self._resolved_device is not None:
            return str(self._resolved_device)
        if self._raw_device is not None:
            return str(self._raw_device)
        try:
            return str(sd.default.device[0])
        except Exception:
            return "0"

    @classmethod
    def resolve_device(cls, target: Optional[Union[str, int]]) -> Optional[Union[int, str]]:
        """Resolve a device name, number, or index into a valid PortAudio device index."""
        if target is None:
            return None
        if str(target).lower() == "browser":
            return "browser"
        try:
            return int(target)
        except (TypeError, ValueError):
            pass
        target_str = str(target)
        try:
            for idx, dev in enumerate(sd.query_devices()):
                if dev.get("max_input_channels", 0) > 0 and target_str.lower() in dev.get("name", "").lower():
                    return idx
        except Exception:
            pass
        return target_str

    def get_devices(self) -> List[Dict[str, Any]]:
        """Query available input devices, safely reinitializing PortAudio if inactive."""
        return self.query_devices(active_stream=self.stream)

    @classmethod
    def query_devices(cls, active_stream=None) -> List[Dict[str, Any]]:
        """Enumerate audio devices with browser audio option at the top."""
        devices = [
            {"id": "browser", "name": "Browser Microphone (Live WebRTC · Recommended)", "raw_name": "browser"}
        ]
        try:
            if active_stream is None:
                try:
                    sd._terminate()
                    sd._initialize()
                except Exception:
                    pass
            dev_list = sd.query_devices()
            try:
                default_in = sd.default.device[0] if sd.default.device else -1
            except Exception:
                default_in = -1
            for idx, dev in enumerate(dev_list):
                if dev.get("max_input_channels", 0) > 0:
                    is_def = (idx == default_in)
                    label = dev["name"] + (" (System Default)" if is_def else "")
                    devices.append({
                        "id": str(idx),
                        "name": label,
                        "is_default": is_def,
                        "raw_name": dev["name"],
                        "channels": dev.get("max_input_channels", 1),
                    })
        except Exception as e:
            print(f"Error querying audio devices: {e}", flush=True)
        return devices

    @classmethod
    def report_devices(cls):
        """Print available hardware input devices to stdout."""
        print("Input devices:")
        try:
            try:
                default_id = sd.default.device[0] if sd.default.device else -1
            except Exception:
                default_id = -1
            for idx, dev in enumerate(sd.query_devices()):
                if dev.get("max_input_channels", 0) > 0:
                    name = dev.get("name", "Unknown")
                    mark = " <-- default" if idx == default_id else ""
                    print(f"  [{idx}] {name}{mark}")
        except Exception as e:
            print(f"  Error enumerating devices: {e}")

    def start(self):
        """Start hardware audio capture if not in browser mode."""
        self._started = True
        if self._is_browser:
            # Frames are injected via ingest_frames(); no hardware device owned.
            return
        if self.stream is not None:
            return
        try:
            self.stream = sd.InputStream(
                samplerate=self.rate,
                channels=1,
                dtype="float32",
                device=self._resolved_device,
                blocksize=1600,
                callback=self._callback,
            )
            self.stream.start()
        except Exception as e:
            print(f"Error opening audio device {self._resolved_device}: {e}", flush=True)
            self.stream = None

    def stop(self):
        """Stop and close the hardware audio stream."""
        self._started = False
        if self.stream is not None:
            try:
                self.stream.stop()
                self.stream.close()
            except Exception:
                pass
            self.stream = None

    def set_device(self, device: Union[str, int]) -> str:
        """Switch audio device dynamically ('browser' or int/string device name)."""
        was_started = self._started
        self.stop()
        if str(device).lower() == "browser":
            self._is_browser = True
            self._raw_device = None
            self._resolved_device = None
            self._started = was_started
            return "browser"

        self._is_browser = False
        self._raw_device = device
        self._resolved_device = self.resolve_device(device)
        if was_started:
            self.start()
        return self.active_device_id

    def ingest_frames(self, samples: Union[List[float], np.ndarray, bytes]):
        """Ingest audio frames from an external source (e.g. browser WebRTC via WebSocket)."""
        if not self._is_browser:
            self.set_device("browser")
            self._started = True

        if samples is None or len(samples) == 0:
            return

        if not isinstance(samples, np.ndarray) or samples.dtype != np.float32 or samples.ndim != 1:
            samples = np.asarray(samples, dtype=np.float32).reshape(-1)

        self.buffer.write(samples)
        self._process_level(samples)

    def write_frames(self, samples):
        """Backwards compatibility alias for ingest_frames."""
        self.ingest_frames(samples)

    def _callback(self, indata, frames, time_info, status):
        """sounddevice InputStream callback."""
        if status:
            pass
        samples = indata[:, 0]
        self.buffer.write(samples)
        self._process_level(samples)

    def _process_level(self, samples: np.ndarray):
        """Calculate RMS level and trigger throttled level callback."""
        if not self.on_level or len(samples) == 0:
            return
        now = time.monotonic()
        with self._vu_lock:
            if now - self._last_vu_time < self.vu_interval:
                return
            self._last_vu_time = now

        try:
            rms = float(np.sqrt(np.mean(samples ** 2)))
            level = min(100, int(rms * 400))
            try:
                self.on_level(level, self.active_device_id)
            except TypeError:
                self.on_level(level)
        except Exception:
            pass

    def latest(self, seconds: float) -> np.ndarray:
        """Retrieve the latest seconds of audio from the ring buffer."""
        return self.buffer.latest(seconds)

    def total_samples(self) -> int:
        """Return the total number of samples written to the ring buffer."""
        return self.buffer.total_samples

    def reset(self):
        """Reset the internal sample ring buffer."""
        self.buffer = RingBuffer()


# Backwards compatibility alias
AudioCapture = AudioSource