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


class Transcriber:
    def __init__(
        self,
        audio,
        model_name="base.en",
        device="cpu",
        compute_type="int8",
        window=4.0,
        tick=1.2,
        align_window=5,
        align_tolerance=3,
        on_sync=None,
        on_status=None,
        on_error=None,
    ):
        self.audio = audio
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self.window = window
        self.tick = tick
        self.align_window = align_window
        self.align_tolerance = align_tolerance

        self.on_sync = on_sync
        self.on_status = on_status
        self.on_error = on_error

        self.model = None
        self.aligner = None
        self.committed_abs_end = 0
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
        """Synchronous load (used by the load thread)."""
        if self.model is not None:
            return
        self.model = WhisperModel(
            self.model_name,
            device=self.device,
            compute_type=self.compute_type,
        )

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
                self.on_status({"model": self.model_name, "ready": True})
        except Exception as exc:  # pragma: no cover - surfaced to UI
            self._loading.clear()
            if self.on_error:
                self.on_error(f"Model load failed: {exc}")

    @property
    def is_ready(self):
        return self.model is not None and not self._loading.is_set()

    def start_loop(self):
        if self.loop_thread and self.loop_thread.is_alive():
            return
        self.loop_thread = threading.Thread(target=self._loop, daemon=True)
        self.loop_thread.start()

    def begin(self, words):
        """Begin a session: reset aligner + committed anchor, run detection."""
        self.aligner = aligner.Aligner(
            words,
            window=self.align_window,
            tolerance=self.align_tolerance,
        )
        self.committed_abs_end = 0
        self.audio.reset()
        self._running.set()

    def stop(self):
        self._running.clear()

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
        audio = self.audio.latest(self.window)
        if len(audio) < int(RATE * 0.5):
            return

        # Silero VAD (vad_filter) rejects quiet audio; always normalise the
        # window to peak 1.0 so quiet mics and synth clips are detected.
        peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
        if peak < 1e-5:
            return
        if abs(peak - 1.0) > 1e-3:
            audio = audio / peak

        start_abs = self.audio.total_samples() - len(audio)
        commit_limit = len(audio) - int(RATE * self.commit_margin_s)

        segments, _info = self.model.transcribe(
            audio,
            vad_filter=True,
            word_timestamps=True,
        )

        new_words = []
        for seg in segments:
            for w in (seg.words or []):
                s = int(w.start * RATE)
                e = int(w.end * RATE)
                if s >= commit_limit:
                    # Word starts too close to the live edge: wait for more audio.
                    continue
                abs_end = start_abs + e
                if abs_end <= self.committed_abs_end:
                    continue
                self.committed_abs_end = abs_end
                new_words.append(aligner.normalize(w.word))

        if not new_words or self.aligner is None:
            return

        matched = self.aligner.align(new_words)
        if matched and self.on_sync:
            for idx in matched:
                self.on_sync(idx)