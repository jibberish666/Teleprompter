"""Fuzzy alignment of ASR words against the script word list.

The cursor is strictly monotonic forward. Normalization strips punctuation,
apostrophes and hyphens and lowercases, so associations like "don't" -> "dont"
collapse cleanly. A few consecutive misses are tolerated before we stop
advancing (pause) rather than skipping ahead on ad-libs.
"""
import re

_DROP_RE = re.compile(r"[^a-z0-9]+")


def normalize(word):
    if not word:
        return ""
    return _DROP_RE.sub("", word.lower()).strip()


def _edit_distance(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _similarity(a, b):
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    if len(a) >= 3 and len(b) >= 3 and (a.startswith(b) or b.startswith(a)):
        return 0.85
    # Fuzzy edit-distance match, guarded so short words / single-char swaps
    # (e.g. "a" vs "d") don't silently skip real script words.
    d = _edit_distance(a, b)
    maxlen = max(len(a), len(b))
    if d <= max(1, maxlen // 4) and d < (maxlen / 2) + 0.5:
        return 0.55 - 0.05 * d
    return 0.0


class Aligner:
    def __init__(self, words, window=5, tolerance=3):
        self.script = [normalize(w) for w in words]
        self.cursor = 0
        self.window = window
        self.tolerance = tolerance
        self.streak = 0

    def align(self, asr_words):
        """Feed a batch of normalized ASR words; return monotonically rising script indices."""
        matched = []
        for tok in asr_words:
            idx = self._match_one(tok)
            if idx is None:
                self.streak += 1
                continue
            self.streak = 0
            if idx >= self.cursor:
                self.cursor = idx + 1
                matched.append(idx)
        return matched

    def _match_one(self, tok):
        if not tok:
            return None
        end = min(len(self.script), self.cursor + self.window)
        best, best_score = None, 0.0
        for i in range(self.cursor, end):
            score = _similarity(tok, self.script[i])
            if score > best_score:
                best, best_score = i, score
        if best is not None and best_score >= 0.5:
            return best
        return None

    @property
    def paused(self):
        return self.streak > self.tolerance