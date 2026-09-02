# Alignment Scoring, Similarity Metrics & Jump Rules

This document specifies the algorithmic formulas and decision thresholds implemented in [`aligner.py`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/aligner.py).

---

## 1. String Similarity Metric (`_similarity(a, b)`)

Given two normalized lowercase alphanumeric strings $a$ and $b$:

1. **Exact Match**:
   $$\text{If } a = b \implies S(a, b) = 1.0$$

2. **Short Word Guard ($\le 3$ characters)**:
   $$\text{If } \min(\text{len}(a), \text{len}(b)) \le 3 \implies S(a, b) = \begin{cases} 1.0 & \text{if } a = b \\ 0.0 & \text{if } a \ne b \end{cases}$$
   *Rationale*: Prevents stop-word false positives such as `"the"` matching `"these"`, `"car"` matching `"careful"`, or `"to"` matching `"so"`.

3. **Stem & Morphological Inflection Matching**:
   Let $\text{cpl}(a, b)$ be the length of the common prefix of $a$ and $b$.
   $$\text{If } \min(\text{len}(a), \text{len}(b)) \ge 5 \text{ and } \text{cpl}(a, b) \ge 4 \text{ and } \frac{\text{cpl}(a, b)}{\min(\text{len}(a), \text{len}(b))} \ge 0.75 \implies S(a, b) = 0.80$$
   *Examples*:
   - `"balance"` (len 7) vs `"balancing"` (len 9): $\text{cpl} = 6 \implies 6/7 = 0.857 \ge 0.75 \implies 0.80$.
   - `"assembly"` (len 8) vs `"assemblies"` (len 10): $\text{cpl} = 7 \implies 7/8 = 0.875 \ge 0.75 \implies 0.80$.
   - `"technics"` (len 8) vs `"techniques"` (len 10): $\text{cpl} = 6 \implies 6/8 = 0.75 \ge 0.75 \implies 0.80$.

4. **Initial Letter Guard & Edit Distance**:
   $$\text{If } a[0] \ne b[0] \implies S(a, b) = 0.0$$
   *Rationale*: Prevents 1-letter rhyming substitutions (`"rotor"` vs `"motor"`, `"light"` vs `"night"`).

   For words with matching initial letter:
   Let $d = \text{Levenshtein}(a, b)$ and $L = \max(\text{len}(a), \text{len}(b))$.
   $$S(a, b) = \begin{cases}
   0.85 & \text{if } L \ge 5 \text{ and } d = 1 \\
   0.75 & \text{if } L \ge 8 \text{ and } d \le 2 \\
   0.0 & \text{otherwise}
   \end{cases}$$

---

## 2. Locality Distance Weighting (Tier 1)

For script candidate offset $k \in [0, \text{window}-1]$ where $\text{window} = 5$:
$$\text{Score}(k) = S(tok, script[\text{cursor} + k]) - 0.10 \times k$$

### Acceptance Thresholds by Offset:
- **$k = 0$ (Immediate next word)**:
  Requires $S \ge 0.70 \implies \text{Score} \ge 0.70$.
- **$k = 1$ (Skipped 1 word)**:
  Requires $S \ge 0.75$ and ($\text{len}(tok) \ge 3$ or $S = 1.0$) $\implies \text{Score} \ge 0.65$.
- **$k \ge 2$ (Skipped 2–4 words)**:
  Requires $S \ge 0.80$ and ($\text{len}(tok) \ge 4$ or $S = 1.0$) $\implies \text{Score} \ge 0.80 - 0.10 \times k$.

Overall acceptance requires $\text{Score} \ge 0.50$.

---

## 3. Forward Jump Multi-Word Sequence Confirmation (Tier 2)

To advance cursor to index $j \ge \text{cursor} + \text{window}$:

1. **2-Word Sequence**:
   - $S(asr[i], script[j]) \ge 0.75$
   - $S(asr[i+1], script[j+1]) \ge 0.75$
   - $\text{len}(asr[i]) + \text{len}(asr[i+1]) \ge 7$ characters.
2. **3-Word Sequence for Short Stop-Words**:
   - If combined length $< 7$ characters:
     - Require $S(asr[i+2], script[j+2]) \ge 0.75$.
