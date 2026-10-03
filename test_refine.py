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


if __name__ == "__main__":
    unittest.main()
