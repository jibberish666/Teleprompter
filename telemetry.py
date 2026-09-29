"""telemetry.py: Telemetry and practice session analytics for the teleprompter.

Decouples rehearsal analytics, fumble tracking, and stumble detection from the
core text alignment engine.
"""
from typing import Any, Callable, Dict, List, Optional, Set

from aligner import _common_prefix_len, _similarity, normalize


class RehearsalObserver:
    """Observes script alignment progress to track fumbles, skips, repetitions, and stumbles.

    Decoupled from Aligner to allow pure text alignment without session analytics overhead.
    """

    def __init__(
        self,
        words: List[str],
        on_fumble: Optional[Callable[[List[Dict[str, Any]]], None]] = None,
        script: Optional[List[str]] = None,
    ):
        self.raw_words = list(words)
        self.script = script if script is not None else [normalize(w) for w in words]
        self.on_fumble = on_fumble
        self.fumbles: List[Dict[str, Any]] = []
        self.fumbled_indices: Set[int] = set()
        self._new_fumbles: List[Dict[str, Any]] = []

    def record_fumble(self, idx: int, reason: str) -> None:
        """Record a fumble at script index if not already recorded."""
        if 0 <= idx < len(self.script) and idx not in self.fumbled_indices:
            clean = self.script[idx]
            if clean:
                self.fumbled_indices.add(idx)
                raw = self.raw_words[idx] if idx < len(self.raw_words) else clean
                fumble_obj = {
                    "index": idx,
                    "word": raw,
                    "clean": clean,
                    "reason": reason,
                }
                self.fumbles.append(fumble_obj)
                self._new_fumbles.append(fumble_obj)

    @property
    def has_new_fumbles(self) -> bool:
        return bool(self._new_fumbles)

    def get_new_fumbles(self) -> List[Dict[str, Any]]:
        new_items = self._new_fumbles[:]
        self._new_fumbles.clear()
        return new_items

    def get_all_fumbles(self) -> List[Dict[str, Any]]:
        return list(self.fumbles)

    def reset(self, words: Optional[List[str]] = None) -> None:
        """Reset fumble state, optionally updating the active script."""
        if words is not None:
            self.raw_words = list(words)
            self.script = [normalize(w) for w in words]
        self.fumbles.clear()
        self.fumbled_indices.clear()
        self._new_fumbles.clear()

    def get_summary(self) -> Dict[str, Any]:
        """Generate high-level summary metrics of the practice session."""
        return {
            "total_fumbles": len(self.fumbles),
            "fumbles": list(self.fumbles),
            "skipped": sum(1 for f in self.fumbles if f.get("reason") == "skipped"),
            "stumbled": sum(1 for f in self.fumbles if f.get("reason") == "stumbled"),
            "repeated": sum(1 for f in self.fumbles if f.get("reason") == "repeated"),
        }

    # -- Observer lifecycle hooks called by Aligner ---------------------------

    def on_token(self, token: str, cursor: int) -> None:
        """Called for each incoming ASR token before matching to detect repetition/stutter."""
        if cursor > 0 and len(token) >= 3:
            for past_idx in range(max(0, cursor - 5), cursor):
                if token == self.script[past_idx]:
                    self.record_fumble(past_idx, "repeated")
                    break

    def on_match(
        self,
        matched_indices: List[int],
        score: float,
        is_compound: bool,
        cursor_before: int,
    ) -> None:
        """Called when a token matches script words in the local window."""
        if not matched_indices:
            return

        first_match = matched_indices[0]
        if first_match > cursor_before:
            for skip_idx in range(cursor_before, first_match):
                self.record_fumble(skip_idx, "skipped")
        elif score < 0.85 and not is_compound:
            self.record_fumble(first_match, "stumbled")

        # Gaps between multi-word matches
        for prev, curr in zip(matched_indices, matched_indices[1:]):
            for skip_idx in range(prev + 1, curr):
                self.record_fumble(skip_idx, "skipped")

    def on_jump(self, matched_indices: List[int], cursor_before: int) -> None:
        """Called when a forward lookahead jump confirms a match."""
        if not matched_indices:
            return

        first_match = matched_indices[0]
        if first_match > cursor_before:
            for skip_idx in range(cursor_before, first_match):
                self.record_fumble(skip_idx, "skipped")

        for prev, curr in zip(matched_indices, matched_indices[1:]):
            for skip_idx in range(prev + 1, curr):
                self.record_fumble(skip_idx, "skipped")

    def on_unmatched(self, token: str, cursor: int) -> None:
        """Called when an ASR token could not be matched; checks for pronunciation stumbles."""
        if cursor < len(self.script):
            expected = self.script[cursor]
            if len(token) >= 3 and len(expected) >= 3:
                sim = _similarity(token, expected)
                if sim >= 0.50 or _common_prefix_len(token, expected) >= 3:
                    self.record_fumble(cursor, "stumbled")

    def on_seek(self, idx: int) -> None:
        """Called when cursor is manually repositioned."""
        pass
