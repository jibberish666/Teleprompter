"""Fuzzy alignment of ASR words against the script word list.

The cursor is strictly monotonic forward. Normalization strips punctuation,
apostrophes and hyphens and lowercases, so associations like "don't" -> "dont"
collapse cleanly.

Matching Architecture:
1. Strict Locality-First Matching (Tight Window: 0 to 4 words from cursor):
   - Immediate next expected word (dist = 0) with distance weighting.
   - Distance penalty sharply reduces scores for words further ahead.
   - Short words (<= 3 chars) strictly require exact matches.
   - Compound words (e.g. split ASR "high" + "speed" or script "turbo" + "charger")
     are cleanly resolved.
2. Mandatory Multi-Word Sequence Confirmation for Jumps (> 4 words):
   - Single-word matches are NEVER accepted beyond the tight local window.
   - Prevents common 3+ or 4+ letter words ("our", "car", "with", "that", "from",
     "machine", "have", "will") from falsely jumping into future sentences.
   - Requires at least 2 consecutive matching words (or 3 for short words)
     before any forward jump is accepted.
"""
import re

_DROP_RE = re.compile(r"[^a-z0-9]+")


def normalize(word):
    if not word:
        return ""
    return _DROP_RE.sub("", word.lower()).strip()


def _common_prefix_len(a, b):
    count = 0
    for ca, cb in zip(a, b):
        if ca == cb:
            count += 1
        else:
            break
    return count


def _edit_distance(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _similarity(a, b):
    """Compute string similarity with strict guarding against false positives."""
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0

    la, lb = len(a), len(b)
    # Short words (<= 3 chars, e.g. "a", "in", "the", "car", "our", "you"):
    # strictly exact match only to prevent false matches like "the" -> "these"
    if la <= 3 or lb <= 3:
        return 1.0 if a == b else 0.0

    min_len = min(la, lb)
    max_len = max(la, lb)

    # Common stem / inflection matching (e.g. "balance" <-> "balancing",
    # "assembly" <-> "assemblies", "technics" <-> "techniques",
    # "accelerates" <-> "accelerating", "operate" <-> "operating")
    cpl = _common_prefix_len(a, b)
    if min_len >= 5 and cpl >= 4 and (cpl / min_len) >= 0.75:
        return 0.80

    # If first letter doesn't match, guard against 1-char rhyme substitutions (e.g. rotor vs motor, light vs night)
    if a[0] != b[0]:
        return 0.0

    # Levenshtein distance for minor phonetic or spelling variations
    d = _edit_distance(a, b)
    if max_len >= 5 and d == 1:
        return 0.85
    if max_len >= 8 and d <= 2:
        return 0.75

    return 0.0


class Aligner:
    def __init__(self, words, window=5, max_lookahead=25, tolerance=5):
        self.script = [normalize(w) for w in words]
        self.cursor = 0
        self.window = window  # Tight local tracking window
        self.max_lookahead = max_lookahead
        self.tolerance = tolerance
        self.streak = 0

    def seek(self, idx):
        """Manually move cursor to a specific word index and reset streak."""
        if 0 <= idx < len(self.script):
            self.cursor = idx
            self.streak = 0

    @property
    def paused(self):
        """True when consecutive unmatched words exceed tolerance."""
        return self.streak > self.tolerance

    def align(self, asr_words):
        """Feed a batch of normalized ASR words; return monotonically rising script indices."""
        matched = []
        i = 0
        while i < len(asr_words):
            tok = asr_words[i]
            if not tok:
                i += 1
                continue

            # -------------------------------------------------------------
            # Phase 1: Tight Local Window Search (0 to window-1 words ahead)
            # Distance-penalized score ensures immediate words are prioritized.
            # -------------------------------------------------------------
            best_idx = None
            best_score = -1.0
            best_compound_asr = False
            best_compound_script = False

            local_limit = min(len(self.script), self.cursor + self.window)
            for k in range(self.cursor, local_limit):
                dist = k - self.cursor
                s_word = self.script[k]

                # Check compound ASR: e.g. ASR ["high", "speed"] == script "highspeed"
                if i + 1 < len(asr_words) and (tok + asr_words[i + 1]) == s_word:
                    score = 1.0 - 0.10 * dist
                    if score > best_score:
                        best_score = score
                        best_idx = k
                        best_compound_asr = True
                        best_compound_script = False
                    continue

                # Check compound script: e.g. ASR "turbocharger" == script ["turbo", "charger"]
                if k + 1 < len(self.script) and tok == (s_word + self.script[k + 1]):
                    score = 1.0 - 0.10 * dist
                    if score > best_score:
                        best_score = score
                        best_idx = k
                        best_compound_script = True
                        best_compound_asr = False
                    continue

                sim = _similarity(tok, s_word)
                if sim <= 0.0:
                    continue

                # Locality-based thresholds & distance penalties
                if dist == 0 and sim >= 0.70:
                    score = sim
                elif dist == 1 and sim >= 0.75 and (len(tok) >= 3 or sim == 1.0):
                    score = sim - 0.10
                elif dist >= 2 and sim >= 0.80 and (len(tok) >= 4 or sim == 1.0):
                    score = sim - 0.10 * dist
                else:
                    continue

                if score > best_score:
                    best_score = score
                    best_idx = k
                    best_compound_asr = False
                    best_compound_script = False

            if best_idx is not None and best_score >= 0.50:
                self.streak = 0
                if best_compound_asr:
                    self.cursor = best_idx + 1
                    matched.append(best_idx)
                    i += 2
                    continue
                elif best_compound_script:
                    self.cursor = best_idx + 2
                    matched.append(best_idx)
                    matched.append(best_idx + 1)
                    i += 1
                    continue
                else:
                    self.cursor = best_idx + 1
                    matched.append(best_idx)
                    i += 1
                    continue

            # -------------------------------------------------------------
            # Phase 2: Forward Jump / Lookahead Recovery
            # MANDATORY multi-word sequence confirmation. Single-word matches
            # are NEVER allowed to jump beyond the local window.
            # -------------------------------------------------------------
            jump_matched = False
            lookahead_limit = min(len(self.script), self.cursor + self.max_lookahead)
            for j in range(local_limit, lookahead_limit):
                if i + 1 < len(asr_words) and j + 1 < len(self.script):
                    s0 = _similarity(tok, self.script[j])
                    s1 = _similarity(asr_words[i + 1], self.script[j + 1])
                    if s0 >= 0.75 and s1 >= 0.75:
                        total_len = len(tok) + len(asr_words[i + 1])
                        # If combined length >= 7 chars, accept 2-word sequence match
                        if total_len >= 7:
                            self.streak = 0
                            self.cursor = j + 2
                            matched.extend([j, j + 1])
                            i += 2
                            jump_matched = True
                            break
                        # For short words (e.g. "in the", "to a"), require a 3rd word
                        elif i + 2 < len(asr_words) and j + 2 < len(self.script):
                            s2 = _similarity(asr_words[i + 2], self.script[j + 2])
                            if s2 >= 0.75:
                                self.streak = 0
                                self.cursor = j + 3
                                matched.extend([j, j + 1, j + 2])
                                i += 3
                                jump_matched = True
                                break

            if jump_matched:
                continue

            # No match found: increment streak and advance ASR token
            self.streak += 1
            i += 1

        return matched