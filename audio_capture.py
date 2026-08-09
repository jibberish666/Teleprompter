"""16kHz mono float32 microphone capture into a thread-safe ring buffer."""
import threading

import numpy as np
import sounddevice as sd

RATE = 16000


class RingBuffer:
    """A fixed-capacity float32 sample buffer.

    Both the sounddevice callback thread and (in --browser-audio mode) the
    WebSocket handler write into this buffer using the same interface, so the
    transcriber sees a single continuous stream regardless of source.
    """

    def __init__(self, capacity_seconds=8.0):
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

    def latest(self, seconds):
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
    def total_samples(self):
        with self.lock:
            return self.total


class AudioCapture:
    """Owns the microphone stream (or accepts browser-audio frames)."""

    def __init__(self, mic=None, browser_audio=False, rate=RATE):
        self.rate = rate
        self.browser_audio = browser_audio
        self.device = mic
        self.buffer = RingBuffer()
        self.stream = None

    def start(self):
        if self.browser_audio:
            # Frames are injected by the server via write_frames(); no device owned.
            return
        self.stream = sd.InputStream(
            samplerate=self.rate,
            channels=1,
            dtype="float32",
            device=self.device,
            blocksize=1600,
            callback=self._callback,
        )
        self.stream.start()

    def _callback(self, indata, frames, time_info, status):
        if status:
            pass
        self.buffer.write(indata[:, 0])

    def write_frames(self, samples):
        """Ingest a chunk from the browser (--browser-audio fallback)."""
        if len(samples) == 0:
            return
        self.buffer.write(samples)

    def latest(self, seconds):
        return self.buffer.latest(seconds)

    def total_samples(self):
        return self.buffer.total_samples

    def reset(self):
        self.buffer = RingBuffer()

    def stop(self):
        if self.stream is not None:
            try:
                self.stream.stop()
                self.stream.close()
            except Exception:
                pass
            self.stream = None