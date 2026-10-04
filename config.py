"""Unified configuration management and persistence for the Teleprompter system.

Provides:
1. Canonical schema definition partitioned into domains (server, engine, audio, recording, ui, script).
2. Deep validation, type enforcement, and bounds clamping.
3. Transparent migration for legacy flat teleprompter.json formats and CLI/env resolution.
4. Thread-safe atomic file persistence (write-to-temp + rename).
5. Scoped domain patch application for real-time WebSocket client synchronization.
"""

import copy
import json
import os
import tempfile
from typing import Any, Dict, List, Optional, Tuple, Union

DEFAULT_CONFIG: Dict[str, Any] = {
    "version": 1,
    "server": {
        "host": "127.0.0.1",
        "port": 8000,
    },
    "engine": {
        "profile": "fast",
        "model": "base.en",
        "compute_type": "int8",
        "device": "cpu",
        "align_window": 5,
        "align_tolerance": 5,
    },
    "audio": {
        "source_type": "hardware",  # "hardware" or "browser"
        "device_id": None,          # int or str or None
        "device_name": "",
    },
    "recording": {
        "mode": "video",            # "video" or "audio"
        "video_format": "mp4",      # "mp4" or "webm"
        "audio_format": "mp3",      # "mp3" or "wav"
    },
    "ui": {
        "box_width_pct": 68,
        "font_size": 36,
        "font_weight": 500,
        "box_opacity": 0.9,
        "visible_lines": 7,
        "mic_sensitivity": 15,
        "mirror_display": False,
        "font_family": "open-sans",
        "auto_format_on_paste": True,
        "persist_transcript": True,
        "sync_fumble_filter": False,
        "difficult_color": "#f59e0b",
        "difficult_style": "pill",
        "difficult_words": [],
        "retake_hotkey": "r",
    },
    "script": {
        "saved_transcript": "",
        "rehearsal_words": [],
    },
}

VALID_PROFILES = {"fast", "balanced", "accurate"}
VALID_SOURCE_TYPES = {"hardware", "browser"}
VALID_RECORD_MODES = {"video", "audio"}
VALID_VIDEO_FORMATS = {"mp4", "webm"}
VALID_AUDIO_FORMATS = {"mp3", "wav"}
VALID_DIFFICULT_STYLES = {"pill", "glow", "underline"}
VALID_FONTS = {"atkinson", "inter", "lexend", "noto-sans", "open-sans", "source-sans-3"}
VALID_FONT_WEIGHTS = {400, 500, 600, 700}


def get_default_config() -> Dict[str, Any]:
    """Return a deep copy of the default configuration."""
    return copy.deepcopy(DEFAULT_CONFIG)


def validate_and_sanitize(raw: Any) -> Dict[str, Any]:
    """Validate and sanitize a configuration dictionary against the canonical schema.

    Repairs missing keys, wrong types, or out-of-bound values with safe defaults.
    """
    if not isinstance(raw, dict):
        return get_default_config()

    result = get_default_config()

    # -- Server domain --
    srv = raw.get("server")
    if isinstance(srv, dict):
        host = srv.get("host")
        if isinstance(host, str) and host.strip():
            result["server"]["host"] = host.strip()
        port = srv.get("port")
        if port is not None:
            try:
                p_int = int(port)
                if 1 <= p_int <= 65535:
                    result["server"]["port"] = p_int
            except (ValueError, TypeError):
                pass

    # -- Engine domain --
    eng = raw.get("engine")
    if isinstance(eng, dict):
        prof = eng.get("profile")
        if isinstance(prof, str) and prof in VALID_PROFILES:
            result["engine"]["profile"] = prof
        model = eng.get("model")
        if isinstance(model, str) and model.strip():
            result["engine"]["model"] = model.strip()
        comp = eng.get("compute_type")
        if isinstance(comp, str) and comp.strip():
            result["engine"]["compute_type"] = comp.strip()
        dev = eng.get("device")
        if isinstance(dev, str) and dev.strip():
            result["engine"]["device"] = dev.strip()
        aw = eng.get("align_window")
        if aw is not None:
            try:
                result["engine"]["align_window"] = max(1, min(50, int(aw)))
            except (ValueError, TypeError):
                pass
        at = eng.get("align_tolerance")
        if at is not None:
            try:
                result["engine"]["align_tolerance"] = max(1, min(50, int(at)))
            except (ValueError, TypeError):
                pass

    # -- Audio domain --
    aud = raw.get("audio")
    if isinstance(aud, dict):
        st = aud.get("source_type")
        if isinstance(st, str) and st in VALID_SOURCE_TYPES:
            result["audio"]["source_type"] = st
        did = aud.get("device_id")
        if did is not None:
            result["audio"]["device_id"] = str(did).strip() if str(did).strip() != "" else None
        dname = aud.get("device_name")
        if isinstance(dname, str):
            result["audio"]["device_name"] = dname.strip()

    # -- Recording domain --
    rec = raw.get("recording")
    if isinstance(rec, dict):
        rm = rec.get("mode")
        if isinstance(rm, str) and rm in VALID_RECORD_MODES:
            result["recording"]["mode"] = rm
        vf = rec.get("video_format")
        if isinstance(vf, str) and vf in VALID_VIDEO_FORMATS:
            result["recording"]["video_format"] = vf
        af = rec.get("audio_format")
        if isinstance(af, str) and af in VALID_AUDIO_FORMATS:
            result["recording"]["audio_format"] = af

    # -- UI domain --
    ui = raw.get("ui")
    if isinstance(ui, dict):
        bw = ui.get("box_width_pct")
        if bw is not None:
            try:
                result["ui"]["box_width_pct"] = max(30, min(100, int(bw)))
            except (ValueError, TypeError):
                pass
        fs = ui.get("font_size")
        if fs is not None:
            try:
                result["ui"]["font_size"] = max(16, min(36, int(fs)))
            except (ValueError, TypeError):
                pass
        fw = ui.get("font_weight")
        if fw is not None:
            try:
                fw_int = int(fw)
                if fw_int in VALID_FONT_WEIGHTS:
                    result["ui"]["font_weight"] = fw_int
                else:
                    result["ui"]["font_weight"] = min(VALID_FONT_WEIGHTS, key=lambda w: abs(w - fw_int))
            except (ValueError, TypeError):
                pass
        bo = ui.get("box_opacity")
        if bo is not None:
            try:
                result["ui"]["box_opacity"] = round(max(0.2, min(1.0, float(bo))), 2)
            except (ValueError, TypeError):
                pass
        vl = ui.get("visible_lines")
        if vl is not None:
            try:
                result["ui"]["visible_lines"] = max(2, min(12, int(vl)))
            except (ValueError, TypeError):
                pass
        ms = ui.get("mic_sensitivity")
        if ms is not None:
            try:
                result["ui"]["mic_sensitivity"] = max(5, min(30, int(ms)))
            except (ValueError, TypeError):
                pass
        if "mirror_display" in ui:
            result["ui"]["mirror_display"] = bool(ui["mirror_display"])
        ff = ui.get("font_family")
        if isinstance(ff, str):
            cleaned_ff = ff.strip().lower()
            if cleaned_ff in VALID_FONTS:
                result["ui"]["font_family"] = cleaned_ff
            else:
                result["ui"]["font_family"] = "open-sans"
        for bkey in ("auto_format_on_paste", "persist_transcript", "sync_fumble_filter"):
            if bkey in ui:
                result["ui"][bkey] = bool(ui[bkey])
        color = ui.get("difficult_color")
        if isinstance(color, str) and color.startswith("#") and len(color) in (4, 7):
            result["ui"]["difficult_color"] = color
        dstyle = ui.get("difficult_style")
        if isinstance(dstyle, str) and dstyle in VALID_DIFFICULT_STYLES:
            result["ui"]["difficult_style"] = dstyle
        dw = ui.get("difficult_words")
        if isinstance(dw, list):
            result["ui"]["difficult_words"] = [str(w).strip().lower() for w in dw if str(w).strip()]
        hk = ui.get("retake_hotkey")
        if isinstance(hk, str) and hk.strip():
            result["ui"]["retake_hotkey"] = hk.strip().lower()[:10]

    # -- Script domain --
    scr = raw.get("script")
    if isinstance(scr, dict):
        st = scr.get("saved_transcript")
        if isinstance(st, str):
            result["script"]["saved_transcript"] = st
        rw = scr.get("rehearsal_words")
        if isinstance(rw, list):
            clean_rw = []
            for w in rw:
                if isinstance(w, dict):
                    word = str(w.get("word") or w.get("clean") or "").strip()
                    clean = str(w.get("clean") or word).strip().lower()
                    reason = str(w.get("reason") or "stumbled").strip()
                    if word and clean != "[object object]" and word.lower() != "[object object]":
                        clean_rw.append({"word": word, "clean": clean, "reason": reason})
                elif isinstance(w, str):
                    s = w.strip()
                    if s and s.lower() != "[object object]":
                        clean_rw.append(s.lower())
            result["script"]["rehearsal_words"] = clean_rw

    return result


def migrate_legacy_dict(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Detect and convert flat legacy config (e.g. {'port': 8000, 'mic': '4'}) to unified schema."""
    if not isinstance(raw, dict):
        return get_default_config()

    # If it already has version, assume structured format
    if "version" in raw and isinstance(raw.get("server"), dict):
        return validate_and_sanitize(raw)

    migrated = get_default_config()
    if "port" in raw:
        try:
            migrated["server"]["port"] = int(raw["port"])
        except (ValueError, TypeError):
            pass
    if "host" in raw:
        migrated["server"]["host"] = str(raw["host"])
    if "mic" in raw and raw["mic"] is not None:
        migrated["audio"]["device_id"] = str(raw["mic"])
    if "profile" in raw and str(raw["profile"]) in VALID_PROFILES:
        migrated["engine"]["profile"] = str(raw["profile"])
    return validate_and_sanitize(migrated)


def load_config(file_path: str) -> Dict[str, Any]:
    """Load configuration from disk with legacy migration and schema fallback."""
    if not os.path.isfile(file_path):
        return get_default_config()

    try:
        with open(file_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return migrate_legacy_dict(data)
    except Exception:
        return get_default_config()


def save_config(cfg: Dict[str, Any], file_path: str) -> bool:
    """Save configuration to disk atomically using a temporary file and rename.

    Prevents file corruption if the process crashes or is killed during write.
    """
    sanitized = validate_and_sanitize(cfg)
    dirname = os.path.dirname(os.path.abspath(file_path))
    os.makedirs(dirname, exist_ok=True)

    try:
        with tempfile.NamedTemporaryFile("w", dir=dirname, delete=False, encoding="utf-8") as tf:
            json.dump(sanitized, tf, indent=2)
            tf.flush()
            os.fsync(tf.fileno())
            temp_name = tf.name

        os.replace(temp_name, file_path)
        return True
    except Exception:
        try:
            if "temp_name" in locals() and os.path.exists(temp_name):
                os.remove(temp_name)
        except OSError:
            pass
        return False


def apply_patch(
    current_cfg: Dict[str, Any],
    domain: str,
    patch_data: Dict[str, Any],
) -> Tuple[Dict[str, Any], bool]:
    """Apply a scoped domain patch to the current configuration.

    Returns:
        (updated_config, was_changed)
    """
    if domain not in ("server", "engine", "audio", "recording", "ui", "script"):
        return current_cfg, False

    if not isinstance(patch_data, dict):
        return current_cfg, False

    candidate = copy.deepcopy(current_cfg)
    domain_dict = candidate.get(domain, {})
    if not isinstance(domain_dict, dict):
        domain_dict = {}

    changed = False
    for k, v in patch_data.items():
        if k in DEFAULT_CONFIG[domain]:
            domain_dict[k] = v
            changed = True

    candidate[domain] = domain_dict
    validated = validate_and_sanitize(candidate)
    return validated, changed
