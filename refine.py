"""Post-recording boundary refinement.

After a session ends, the whole recording is transcribed again (no time
pressure) with a timestamp for every spoken word. This module lines those
timestamped words up against the script and reports, for each script section,
when its first word was actually spoken and when its last word finished.

Matching is a single monotonic pass (script order == speech order) that
tolerates misheard words, e.g. "VSR400" heard as "VSR 400".
"""
import difflib
import re

_TOKEN = re.compile(r"[a-z0-9]+")


def normalize_words(text):
    """Lowercase text and split into alphanumeric tokens (punctuation dropped)."""
    return _TOKEN.findall(str(text or "").lower())


def _align_monotonic(sections, spoken):
    script_tokens = []   # flat list of script tokens
    owner = []           # section index for each script token
    for si, sec in enumerate(sections):
        for tok in normalize_words(sec.get("text", "")):
            script_tokens.append(tok)
            owner.append(si)

    # A spoken entry may contain several tokens (e.g. "300,000"); give every
    # token the timing of its parent word.
    spoken_tokens = []
    spoken_times = []
    for w in spoken or []:
        for tok in normalize_words(w.get("word", "")):
            spoken_tokens.append(tok)
            spoken_times.append((float(w.get("start", 0.0)), float(w.get("end", 0.0))))

    result = {sec.get("id"): None for sec in sections}
    if not script_tokens or not spoken_tokens:
        return result

    matcher = difflib.SequenceMatcher(None, script_tokens, spoken_tokens, autojunk=False)
    first = {}  # section index -> earliest matched spoken token index
    last = {}   # section index -> latest matched spoken token index
    for block in matcher.get_matching_blocks():
        for k in range(block.size):
            si = owner[block.a + k]
            sp = block.b + k
            if si not in first or sp < first[si]:
                first[si] = sp
            if si not in last or sp > last[si]:
                last[si] = sp

    for si, sec in enumerate(sections):
        if si in first:
            result[sec.get("id")] = {
                "startSec": spoken_times[first[si]][0],
                "endSec": spoken_times[last[si]][1],
            }
    return result


def align_sections(sections, spoken):
    """Find the real audio times for each script section.

    sections: ordered list of {"id": str, "text": str, "retakeSec": float | None}.
    spoken:   ordered list of {"word": str, "start": float, "end": float}
              as produced by the full-file transcription pass.

    Returns {section_id: {"startSec": float, "endSec": float} | None}.
    A section with no matched words maps to None so callers can fall back to
    the live-tracked boundaries.
    """
    if not sections:
        return {}

    has_retakes = any(
        s.get("retakeSec") is not None and float(s.get("retakeSec", 0)) > 0
        for s in sections
    )
    if not has_retakes:
        return _align_monotonic(sections, spoken)

    # Partition sections into epochs at retake boundaries.
    # Words spoken before a section's retake timestamp belong to the aborted take,
    # so each epoch aligns only the script sections and spoken words valid for that time window.
    epochs = []
    curr_secs = []
    curr_min_time = float(sections[0].get("retakeSec") or 0.0)

    for i, sec in enumerate(sections):
        r_sec = sec.get("retakeSec")
        if i > 0 and r_sec is not None and float(r_sec) > 0:
            r_val = float(r_sec)
            epochs.append((curr_secs, curr_min_time, r_val))
            curr_secs = [sec]
            curr_min_time = r_val
        else:
            curr_secs.append(sec)

    epochs.append((curr_secs, curr_min_time, float("inf")))

    result = {}
    for epoch_secs, min_t, max_t in epochs:
        if not epoch_secs:
            continue
        epoch_spoken = [
            w for w in (spoken or [])
            if float(w.get("start", 0.0)) >= min_t and float(w.get("start", 0.0)) < max_t
        ]
        epoch_res = _align_monotonic(epoch_secs, epoch_spoken)
        result.update(epoch_res)

    return result


class RefineUpload:
    """Collects base64-encoded 16 kHz mono int16 PCM chunks sent by the browser.

    The server limits each WebSocket message to 2 MB, so the browser sends the
    decoded recording in pieces; this puts them back together in order.
    """

    def __init__(self):
        self._chunks = {}

    def add(self, seq, b64_data):
        import base64
        self._chunks[int(seq)] = base64.b64decode(b64_data)

    def to_samples(self):
        """Return the joined audio as float32 in [-1, 1] (what Whisper expects)."""
        import numpy as np
        raw = b"".join(self._chunks[k] for k in sorted(self._chunks))
        raw = raw[: len(raw) - (len(raw) % 2)]  # drop a dangling odd byte
        return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
