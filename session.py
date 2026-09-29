"""PrompterSession: Teleprompter Session Coordinator deep module.

Encapsulates speech alignment orchestration, audio ingestion, model lifecycle,
session state transitions (idle, running, rehearsal, stopped), and client
event dispatching behind a clean, testable interface.
"""
import json
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Union

import audio_capture
import telemetry
import transcriber


class SessionState(str, Enum):
    IDLE = "idle"
    RUNNING = "running"
    REHEARSING = "rehearsing"
    STOPPED = "stopped"


class PrompterSession:
    """Orchestrates audio capture, speech transcription, alignment, and session state.

    Decouples the core teleprompter engine from network transport (WebSocket / HTTP).
    Emits structured payloads to an event sink (e.g. SyncHub or test collector).
    """

    def __init__(
        self,
        event_sink: Optional[Callable[[Dict[str, Any]], None]] = None,
        on_config_save: Optional[Callable[..., None]] = None,
        audio_source: Optional[audio_capture.AudioSource] = None,
        trans: Optional[transcriber.Transcriber] = None,
        mic: Optional[str] = None,
        browser_audio: bool = False,
        profile: str = "fast",
        model_name: Optional[str] = None,
        device: str = "cpu",
        compute_type: str = "int8",
        tick: Optional[float] = None,
        window: Optional[float] = None,
        align_window: int = 5,
        align_tolerance: int = 5,
        host: str = "127.0.0.1",
        port: int = 8000,
    ):
        self.event_sink = event_sink
        self.on_config_save = on_config_save
        self.host = host
        self.port = port

        self.state = SessionState.IDLE
        self.is_rehearsal = False
        self.rehearsal_observer: Optional[telemetry.RehearsalObserver] = None

        # Unified audio source
        if audio_source is not None:
            self.audio_source = audio_source
        else:
            self.audio_source = audio_capture.AudioSource(
                device=mic,
                browser_audio=browser_audio,
                on_level=self._on_level,
            )

        # Pick profile defaults or explicit overrides
        prof_key = profile if profile in transcriber.ENGINE_PROFILES else "fast"
        prof = transcriber.ENGINE_PROFILES[prof_key]
        resolved_model = model_name if model_name is not None else prof["model_name"]
        resolved_tick = tick if tick is not None else prof["tick"]
        resolved_window = window if window is not None else prof["window"]
        resolved_beam = prof.get("beam_size", 1)

        # Transcriber engine
        if trans is not None:
            self.transcriber = trans
        else:
            self.transcriber = transcriber.Transcriber(
                audio=self.audio_source,
                model_name=resolved_model,
                device=device,
                compute_type=compute_type,
                window=resolved_window,
                tick=resolved_tick,
                beam_size=resolved_beam,
                profile=prof_key,
                align_window=align_window,
                align_tolerance=align_tolerance,
                on_sync=self._on_sync,
                on_status=self._on_status,
                on_error=self._on_error,
                on_fumble=self._on_fumble,
            )

    # -- Event emission & callbacks -------------------------------------------

    def emit(self, payload: Dict[str, Any]) -> None:
        """Deliver payload to registered event sink (thread-safe)."""
        if self.event_sink:
            try:
                self.event_sink(payload)
            except Exception:
                pass

    def _on_level(self, level: float, device: str) -> None:
        self.emit({"type": "vu", "level": level, "device": device})

    def _on_sync(self, idx: int) -> None:
        self.emit({"type": "sync", "word_index": idx, "state": "speaking"})

    def _on_status(self, payload: Dict[str, Any]) -> None:
        if payload.get("ready") in (True, False):
            # One-time readiness broadcast also carries source config.
            payload = {
                **payload,
                "browser_audio": self.audio_source.is_browser,
                "host": self.host,
                "port": self.port,
            }
        self.emit({"type": "status", **payload})

    def _on_error(self, message: str) -> None:
        self.emit({"type": "error", "message": message})

    def _on_fumble(self, fumbles: Any) -> None:
        self.emit({"type": "fumble", "fumbles": fumbles})

    # -- Lifecycle management -------------------------------------------------

    def start(self) -> None:
        """Start audio ingestion and transcriber background workers."""
        self.audio_source.start()
        self.transcriber.start_loading_async()
        self.transcriber.start_loop()

    def shutdown(self) -> None:
        """Stop background worker threads and audio streams."""
        self.transcriber.shutdown()
        self.audio_source.stop()

    @property
    def is_ready(self) -> bool:
        return self.transcriber.is_ready

    @property
    def is_running(self) -> bool:
        return self.state in (SessionState.RUNNING, SessionState.REHEARSING)

    @property
    def profile(self) -> str:
        return self.transcriber.profile

    @property
    def model_name(self) -> str:
        return self.transcriber.model_name

    @property
    def tick(self) -> float:
        return self.transcriber.tick

    @property
    def is_browser_audio(self) -> bool:
        return self.audio_source.is_browser

    # -- Client initialization payloads --------------------------------------

    def get_config_payload(self) -> Dict[str, Any]:
        """Construct current configuration for client sync."""
        return {
            "type": "config",
            "browser_audio": self.audio_source.is_browser,
            "profile": self.transcriber.profile,
            "profiles": transcriber.ENGINE_PROFILES,
            "audio_devices": self.audio_source.get_devices(),
            "active_audio_device": self.audio_source.active_device_id,
        }

    def get_status_payload(self) -> Dict[str, Any]:
        """Construct current engine status for client sync."""
        return {
            "type": "status",
            "model": self.transcriber.model_name,
            "ready": self.transcriber.is_ready,
            "profile": self.transcriber.profile,
            "tick": self.transcriber.tick,
            "active_audio_device": self.audio_source.active_device_id,
        }

    def get_initial_messages(self) -> List[Dict[str, Any]]:
        """Return payloads that a newly connected client should immediately receive."""
        return [self.get_config_payload(), self.get_status_payload()]

    # -- Session actions ------------------------------------------------------

    def start_session(
        self,
        words: List[str],
        rehearsal: bool = False,
        audio_device: Optional[Union[int, str]] = None,
    ) -> bool:
        """Start or restart a teleprompter tracking session."""
        if audio_device is not None:
            self.set_audio_device(audio_device)

        if not self.transcriber.is_ready:
            self.emit({"type": "error", "message": "Model still loading. Try again shortly."})
            return False

        if not words:
            self.emit({"type": "error", "message": "No transcript to run."})
            return False

        self.is_rehearsal = bool(rehearsal)
        self.state = SessionState.REHEARSING if self.is_rehearsal else SessionState.RUNNING

        self.rehearsal_observer = telemetry.RehearsalObserver(
            words,
            on_fumble=self._on_fumble,
        )

        try:
            self.transcriber.begin(words, is_rehearsal=self.is_rehearsal, observer=self.rehearsal_observer)
        except TypeError:
            self.transcriber.begin(words, is_rehearsal=self.is_rehearsal)

        if hasattr(self.transcriber, "aligner") and self.transcriber.aligner is not None:
            if hasattr(self.transcriber.aligner, "observer") and self.transcriber.aligner.observer is None:
                self.transcriber.aligner.observer = self.rehearsal_observer

        self.emit({
            "type": "status",
            "state": "running",
            "running": True,
            "rehearsal": self.is_rehearsal,
        })
        return True

    def stop_session(self) -> None:
        """Stop tracking session and emit rehearsal/fumble summary if applicable."""
        all_fumbles = []
        if self.rehearsal_observer is not None:
            all_fumbles = self.rehearsal_observer.get_all_fumbles()
        if not all_fumbles and self.transcriber and getattr(self.transcriber, "aligner", None):
            if hasattr(self.transcriber.aligner, "get_all_fumbles"):
                all_fumbles = self.transcriber.aligner.get_all_fumbles()
        was_rehearsal = self.is_rehearsal

        self.transcriber.stop()
        self.state = SessionState.STOPPED

        self.emit({
            "type": "status",
            "state": "stopped",
            "running": False,
            "rehearsal": was_rehearsal,
        })

        if was_rehearsal or all_fumbles:
            self.emit({
                "type": "rehearsal_summary",
                "fumbles": all_fumbles,
            })

    def seek(self, word_index: int) -> None:
        """Directly adjust current prompter script position."""
        self.transcriber.seek(int(word_index))

    def set_engine(self, mode: str) -> bool:
        """Dynamically switch engine profile/model."""
        if mode and self.transcriber.set_profile(mode):
            return True
        return False

    def set_audio_device(self, device: Union[int, str]) -> None:
        """Switch audio input device and persist choice."""
        self.audio_source.set_device(device)
        if self.on_config_save:
            try:
                self.on_config_save(mic=str(device))
            except Exception:
                pass
        self.emit({
            "type": "audio_device_changed",
            "device": self.audio_source.active_device_id,
            "is_browser": self.audio_source.is_browser,
        })

    def refresh_audio_devices(self) -> None:
        """Query available audio hardware and notify clients."""
        self.emit(self.get_config_payload())

    def ingest_audio_frames(self, data: Any) -> None:
        """Ingest raw PCM audio frames streamed from client browser."""
        if data:
            self.audio_source.ingest_frames(data)

    # -- Message Dispatcher ---------------------------------------------------

    def dispatch(self, raw_or_msg: Union[str, Dict[str, Any]]) -> None:
        """Route incoming client message to corresponding session action."""
        if isinstance(raw_or_msg, str):
            try:
                msg = json.loads(raw_or_msg)
            except (TypeError, ValueError):
                return
        elif isinstance(raw_or_msg, dict):
            msg = raw_or_msg
        else:
            return

        mtype = msg.get("type")
        if mtype == "start":
            self.start_session(
                words=msg.get("words") or [],
                rehearsal=bool(msg.get("rehearsal")),
                audio_device=msg.get("audio_device"),
            )
        elif mtype == "stop":
            self.stop_session()
        elif mtype == "seek":
            idx = msg.get("word_index")
            if idx is not None:
                self.seek(int(idx))
        elif mtype == "set_engine":
            self.set_engine(msg.get("mode"))
        elif mtype == "set_audio_device":
            device = msg.get("device")
            if device is not None:
                self.set_audio_device(device)
        elif mtype == "refresh_audio_devices":
            self.refresh_audio_devices()
        elif mtype == "audio":
            self.ingest_audio_frames(msg.get("data"))


# Convenient alias
EngineCoordinator = PrompterSession
