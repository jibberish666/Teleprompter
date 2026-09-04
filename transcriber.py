"""faster-whisper load + rolling-window transcription + alignment loop.

Loads the model once (in its own thread) and runs a background loop that, every
`tick` seconds, re-transcribes only the tail of the audio stream: a committed
anchor (last word boundary) is kept so previously committed words are never
re-processed or re-aligned.
"""
import threading
import time

import numpy as np
from faster_whisper import WhisperModel

import aligner
from audio_capture import RATE

ENGINE_PROFILES = {
    "ultrafast": {
        "label": "Ultra Fast",
        "model_name": "tiny.en",
        "tick": 0.4,
        "window": 2.5,
        "beam_size": 1,
        "description": "0.4s interval, tiny.en model (lowest latency)",
    },
    "fast": {
        "label": "Fast",
        "model_name": "base.en",
        "tick": 0.6,
        "window": 3.0,
        "beam_size": 1,
        "description": "0.6s interval, base.en model (fast + accurate)",
    },
    "standard": {
        "label": "Standard",
        "model_name": "base.en",
        "tick": 1.2,
        "window": 4.0,
        "beam_size": 5,
        "description": "1.2s interval, base.en model (original)",
    },
}

_MODEL_CACHE = {}
_MODEL_CACHE_LOCK = threading.Lock()


class Transcriber:
    def __init__(
        self,
        audio,
        profile="fast",
        model_name=None,
        device="cpu",
        compute_type="int8",
        window=None,
        tick=None,
        beam_size=None,
        align_window=5,
        align_tolerance=5,
        on_sync=None,
        on_status=None,
        on_error=None,
        on_fumble=None,
    ):
        self.profile = profile if profile in ENGINE_PROFILES else "fast"
        prof = ENGINE_PROFILES[self.profile]

        self.audio = audio
        self.model_name = model_name if model_name is not None else prof["model_name"]
        self.device = device
        self.compute_type = compute_type
        self.window = float(window if window is not None else prof["window"])
        self.tick = float(tick if tick is not None else prof["tick"])
        self.beam_size = int(beam_size if beam_size is not None else prof["beam_size"])
        self.align_window = align_window
        self.align_tolerance = align_tolerance

        self.on_sync = on_sync
        self.on_status = on_status
        self.on_error = on_error
        self.on_fumble = on_fumble

        self.model = None
        self.aligner = None
        self.is_rehearsal = False
        self.committed_abs_end = 0.0
        self.silent_ticks = 0
        # Small tail overlap: words ending within this margin of the live edge
        # are treated as "too new" and left for the next tick.
        self.commit_margin_s = 0.5

        self._running = threading.Event()
        self._loading = threading.Event()
        self.load_thread = None
        self.loop_thread = None
        self._stop = threading.Event()

    # -- lifecycle ---------------------------------------------------------

    def load(self):
        """Synchronous load (used by the load thread) with in-memory caching."""
        cache_key = (self.model_name, self.device, self.compute_type)
        with _MODEL_CACHE_LOCK:
            if cache_key in _MODEL_CACHE:
                self.model = _MODEL_CACHE[cache_key]
                return

        model = WhisperModel(
            self.model_name,
            device=self.device,
            compute_type=self.compute_type,
            cpu_threads=4,
        )
        with _MODEL_CACHE_LOCK:
            _MODEL_CACHE[cache_key] = model
            self.model = model

    def start_loading_async(self):
        if self.load_thread and self.load_thread.is_alive():
            return
        self._loading.set()
        self._stop.clear()
        self.load_thread = threading.Thread(target=self._load_worker, daemon=True)
        self.load_thread.start()

    def _load_worker(self):
        try:
            self.load()
            self._loading.clear()
            if self.on_status:
                self.on_status({
                    "model": self.model_name,
                    "ready": True,
                    "profile": self.profile,
                    "tick": self.tick,
                })
        except Exception as exc:  # pragma: no cover - surfaced to UI
            self._loading.clear()
            if self.on_error:
                self.on_error(f"Model load failed: {exc}")

    @property
    def is_ready(self):
        return self.model is not None and not self._loading.is_set()

    def set_profile(self, profile_name):
        """Dynamically switch between speed/model profiles."""
        if profile_name not in ENGINE_PROFILES:
            return False
        prof = ENGINE_PROFILES[profile_name]
        self.profile = profile_name
        self.tick = prof["tick"]
        self.window = prof["window"]
        self.beam_size = prof["beam_size"]

        target_model = prof["model_name"]
        if target_model != self.model_name:
            self.model_name = target_model
            cache_key = (self.model_name, self.device, self.compute_type)
            with _MODEL_CACHE_LOCK:
                cached = _MODEL_CACHE.get(cache_key)
            if cached is not None:
                self.model = cached
                if self.on_status:
                    self.on_status({
                        "model": self.model_name,
                        "ready": True,
                        "profile": self.profile,
                        "tick": self.tick,
                    })
            else:
                self.model = None
                if self.on_status:
                    self.on_status({
                        "model": self.model_name,
                        "ready": False,
                        "profile": self.profile,
                    })
                self.start_loading_async()
        else:
            if self.on_status:
                self.on_status({
                    "model": self.model_name,
                    "ready": self.is_ready,
                    "profile": self.profile,
                    "tick": self.tick,
                })
        return True

    def start_loop(self):
        if self.loop_thread and self.loop_thread.is_alive():
            return
        self.loop_thread = threading.Thread(target=self._loop, daemon=True)
        self.loop_thread.start()

    def begin(self, words, is_rehearsal=False):
        """Begin a session: reset aligner + committed anchor, run detection."""
        self.aligner = aligner.Aligner(
            words,
            window=self.align_window,
            tolerance=self.align_tolerance,
        )
        self.is_rehearsal = bool(is_rehearsal)
        self.committed_abs_end = 0.0
        self.silent_ticks = 0
        self.audio.reset()
        self._running.set()

    def seek(self, idx):
        """Forward manual seek/jump to aligner."""
        if self.aligner is not None:
            self.aligner.seek(idx)

    def stop(self):
        self._running.clear()
        self.silent_ticks = 0

    def shutdown(self):
        self._stop.set()

    # -- detection loop ------------------------------------------------------

    def _loop(self):
        while not self._stop.is_set():
            if not self._running.is_set() or not self.is_ready:
                time.sleep(0.1)
                continue
            try:
                self._tick()
            except Exception as exc:  # pragma: no cover
                if self.on_error:
                    self.on_error(f"Transcribe error: {exc}")
            time.sleep(self.tick)

    @property
    def paused(self):
        return self.aligner is not None and self.aligner.paused

    def _tick(self):
        if not self.is_ready or self.model is None:
            return
        audio = self.audio.latest(self.window)
        if len(audio) < int(RATE * 0.5):
            return

        # Silero VAD (vad_filter) rejects quiet audio; always normalise the
        # window to peak 1.0 so quiet mics and synth clips are detected.
        peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
        if peak < 1e-5:
            self.silent_ticks += 1
            if self.silent_ticks == 4 and self.on_status:
                self.on_status({
                    "mic_warning": True,
                    "message": "Selected audio input is silent (no signal detected). Switch audio source or select 'Browser Microphone' in Script & Options.",
                })
            return
        else:
            if self.silent_ticks >= 4 and self.on_status:
                self.on_status({"mic_warning": False})
            self.silent_ticks = 0
        if abs(peak - 1.0) > 1e-3:
            audio = audio / peak

        start_abs_s = (self.audio.total_samples() - len(audio)) / float(RATE)
        commit_limit_s = (len(audio) / float(RATE)) - self.commit_margin_s

        segments, _info = self.model.transcribe(
            audio,
            beam_size=getattr(self, "beam_size", 1),
            condition_on_previous_text=False,
            vad_filter=True,
            word_timestamps=True,
        )

        new_words = []
        for seg in segments:
            for w in (seg.words or []):
                if w.start >= commit_limit_s:
                    # Word starts too close to the live edge: wait for more audio.
                    continue
                abs_start = start_abs_s + w.start
                abs_end = start_abs_s + w.end
                # Word must not end before already committed boundary, and its start
                # must not be significantly behind the committed boundary (prevents jitter duplicates)
                if abs_end <= self.committed_abs_end or abs_start < (self.committed_abs_end - 0.15):
                    continue
                self.committed_abs_end = max(self.committed_abs_end, abs_end)
                norm = aligner.normalize(w.word)
                if norm:
                    new_words.append(norm)

        if not new_words or self.aligner is None:
            return

        matched = self.aligner.align(new_words)
        if matched and self.on_sync:
            for idx in matched:
                self.on_sync(idx)

        if self.aligner.has_new_fumbles and self.on_fumble:
            self.on_fumble(self.aligner.get_new_fumbles())