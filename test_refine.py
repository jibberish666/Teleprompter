import unittest

import refine

S1 = ("Introducing the Turbo Technics VSR400 EVO, the next evolution in high-speed "
      "core balancing for passenger car and light commercial turbocharger core assemblies.")
S2 = ("By balancing the core assembly at up to 300,000 rpm, residual imbalance within "
      "the complete rotating assembly can be identified and corrected, before the "
      "turbocharger is fully assembled.")


def fake_speech(text, t0, per_word=0.4):
    """Build timestamped spoken words (VSR400 is heard as two words)."""
    text = text.replace("VSR400", "VSR 400")
    out = []
    t = t0
    for w in text.split():
        out.append({"word": w, "start": t, "end": t + per_word * 0.9})
        t += per_word
    return out, t


class RefineTests(unittest.TestCase):
    def setUp(self):
        self.sections = [{"id": "s1", "text": S1}, {"id": "s2", "text": S2}]

    def test_boundary_matches_real_speech_despite_misheard_word(self):
        w1, t = fake_speech(S1, 0.0)
        w2, _ = fake_speech(S2, t + 0.8)  # 0.8s breath between sections
        res = refine.align_sections(self.sections, w1 + w2)
        self.assertAlmostEqual(res["s1"]["startSec"], 0.0, places=2)
        self.assertAlmostEqual(res["s2"]["startSec"], w2[0]["start"], places=2)
        self.assertAlmostEqual(res["s2"]["endSec"], w2[-1]["end"], places=2)
        self.assertLess(res["s1"]["endSec"], res["s2"]["startSec"])

    def test_unreached_section_is_none(self):
        w1, _ = fake_speech(S1, 0.0)
        res = refine.align_sections(self.sections, w1)
        self.assertIsNotNone(res["s1"])
        self.assertIsNone(res["s2"])

    def test_empty_speech(self):
        res = refine.align_sections(self.sections, [])
        self.assertEqual(res, {"s1": None, "s2": None})

    def test_retake_discards_aborted_take_and_snaps_to_clean_take(self):
        # Section 1 spoken cleanly
        w1, t = fake_speech(S1, 0.0)
        s1_end = w1[-1]["end"]

        # Section 2 aborted take 1 (only first 6 words spoken)
        s2_partial = " ".join(S2.split()[:6])
        w2_aborted, t_abort = fake_speech(s2_partial, t + 0.5)

        # Retake key pressed at retake_time
        retake_time = t_abort + 0.5

        # Section 2 clean take 2 spoken after retake
        w2_clean, _ = fake_speech(S2, retake_time + 0.8)

        sections_with_retake = [
            {"id": "s1", "text": S1},
            {"id": "s2", "text": S2, "retakeSec": retake_time},
        ]
        all_spoken = w1 + w2_aborted + w2_clean
        res = refine.align_sections(sections_with_retake, all_spoken)

        self.assertIsNotNone(res["s1"])
        self.assertIsNotNone(res["s2"])
        # Section 1 ends before retake
        self.assertLess(res["s1"]["endSec"], retake_time)
        # Section 2 starts at clean take, strictly discarding aborted take 1
        self.assertGreaterEqual(res["s2"]["startSec"], retake_time)
        self.assertAlmostEqual(res["s2"]["startSec"], w2_clean[0]["start"], places=2)
        self.assertAlmostEqual(res["s2"]["endSec"], w2_clean[-1]["end"], places=2)


if __name__ == "__main__":
    unittest.main()
