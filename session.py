"""PrompterSession: Teleprompter Session Coordinator deep module.

Encapsulates speech alignment orchestration, audio ingestion, model lifecycle,
session state transitions (idle, running, rehearsal, stopped), and client
event dispatching behind a clean, testable interface.
"""
import json
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Union

import copy
import aligner
import audio_capture
import config
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
        config_path: Optional[str] = None,
        cfg: Optional[Dict[str, Any]] = None,
    ):
        self.event_sink = event_sink
        self.on_config_save = on_config_save
        self.config_path = config_path
        self.host = host
        self.port = port

        # Load or initialize unified schema
        if cfg is not None:
            self.cfg = config.validate_and_sanitize(cfg)
        elif config_path:
            self.cfg = config.load_config(config_path)
        else:
            self.cfg = config.get_default_config()

        self.cfg["server"]["host"] = host
        self.cfg["server"]["port"] = port
        if mic is not None:
            self.cfg["audio"]["device_id"] = str(mic)
        if browser_audio:
            self.cfg["audio"]["source_type"] = "browser"
        if profile:
            self.cfg["engine"]["profile"] = profile
        if model_name:
            self.cfg["engine"]["model"] = model_name
        self.cfg["engine"]["compute_type"] = compute_type
        self.cfg["engine"]["device"] = device
        self.cfg["engine"]["align_window"] = align_window
        self.cfg["engine"]["align_tolerance"] = align_tolerance

        self.state = SessionState.IDLE
        self.is_rehearsal = False
        self.rehearsal_observer: Optional[telemetry.RehearsalObserver] = None
        self.align_window = align_window
        self.align_tolerance = align_tolerance
        self.aligner: Optional[aligner.Aligner] = None

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
            # If transcriber supports on_words, wire it
            if hasattr(self.transcriber, "on_words") and self.transcriber.on_words is None:
                self.transcriber.on_words = self._on_words
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
                on_words=self._on_words,
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

    def _on_words(self, words: List[str]) -> None:
        """Process freshly recognized words from transcriber and advance script alignment."""
        if not words or self.aligner is None or not self.is_running:
            return
        matched = self.aligner.align(words)
        if matched:
            for idx in matched:
                self._on_sync(idx)
        if self.aligner.has_new_fumbles:
            self._on_fumble(self.aligner.get_new_fumbles())

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
            "config": copy.deepcopy(self.cfg),
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

        self.aligner = aligner.Aligner(
            words,
            window=self.align_window,
            tolerance=self.align_tolerance,
            observer=self.rehearsal_observer,
        )

        if hasattr(self.transcriber, "start"):
            self.transcriber.start()

        if hasattr(self.transcriber, "begin"):
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
        if not all_fumbles and self.aligner and hasattr(self.aligner, "get_all_fumbles"):
            all_fumbles = self.aligner.get_all_fumbles()
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
        idx = int(word_index)
        if self.aligner is not None:
            self.aligner.seek(idx)
        if hasattr(self.transcriber, "seek"):
            try:
                self.transcriber.seek(idx)
            except Exception:
                pass

    def patch_config(self, domain: str, patch_data: Dict[str, Any]) -> None:
        """Apply scoped domain patch, persist to disk, and trigger runtime side effects."""
        self.cfg, changed = config.apply_patch(self.cfg, domain, patch_data)
        if changed:
            if self.config_path:
                config.save_config(self.cfg, self.config_path)
            # Side-effects for runtime engines
            if domain == "audio":
                if "device_id" in patch_data and patch_data["device_id"] is not None:
                    self.audio_source.set_device(patch_data["device_id"])
            elif domain == "engine":
                if "profile" in patch_data and patch_data["profile"]:
                    self.transcriber.set_profile(patch_data["profile"])

            self.emit({
                "type": "config_updated",
                "domain": domain,
                "data": self.cfg.get(domain, {}),
                "config": copy.deepcopy(self.cfg),
            })

    def set_engine(self, mode: str) -> bool:
        """Dynamically switch engine profile/model."""
        if mode and self.transcriber.set_profile(mode):
            self.cfg["engine"]["profile"] = mode
            if self.config_path:
                config.save_config(self.cfg, self.config_path)
            self.emit({
                "type": "config_updated",
                "domain": "engine",
                "data": self.cfg.get("engine", {}),
                "config": copy.deepcopy(self.cfg),
            })
            return True
        return False

    def set_audio_device(self, device: Union[int, str]) -> None:
        """Switch audio input device and persist choice."""
        self.audio_source.set_device(device)
        self.cfg["audio"]["device_id"] = str(device)
        if self.config_path:
            config.save_config(self.cfg, self.config_path)
        if self.on_config_save:
            try:
                self.on_config_save(mic=str(device))
            except Exception:
                pass
        self.emit({
            "type": "config_updated",
            "domain": "audio",
            "data": self.cfg.get("audio", {}),
            "config": copy.deepcopy(self.cfg),
        })
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
        elif mtype == "config_patch":
            self.patch_config(msg.get("domain") or "", msg.get("data") or {})
        elif mtype == "refresh_audio_devices":
            self.refresh_audio_devices()
        elif mtype == "audio":
            self.ingest_audio_frames(msg.get("data"))


# Convenient alias
EngineCoordinator = PrompterSession
