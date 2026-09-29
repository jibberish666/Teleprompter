"""Unit tests for config.py schema validation, persistence, and patching."""
import json
import os
import tempfile
import unittest

import config


class TestConfigValidation(unittest.TestCase):
    def test_default_config_structure(self):
        cfg = config.get_default_config()
        self.assertEqual(cfg["version"], 1)
        self.assertIn("server", cfg)
        self.assertIn("engine", cfg)
        self.assertIn("audio", cfg)
        self.assertIn("recording", cfg)
        self.assertIn("ui", cfg)
        self.assertIn("script", cfg)
        self.assertEqual(cfg["ui"]["box_width_pct"], 68)

    def test_sanitize_clamps_bounds(self):
        # Box width clamped between 30 and 100
        raw = {"ui": {"box_width_pct": 10}}
        cfg = config.validate_and_sanitize(raw)
        self.assertEqual(cfg["ui"]["box_width_pct"], 30)

        raw = {"ui": {"box_width_pct": 200}}
        cfg = config.validate_and_sanitize(raw)
        self.assertEqual(cfg["ui"]["box_width_pct"], 100)

    def test_sanitize_profile_validation(self):
        raw = {"engine": {"profile": "invalid_mode"}}
        cfg = config.validate_and_sanitize(raw)
        self.assertEqual(cfg["engine"]["profile"], "fast")

        raw = {"engine": {"profile": "accurate"}}
        cfg = config.validate_and_sanitize(raw)
        self.assertEqual(cfg["engine"]["profile"], "accurate")

    def test_sanitize_handles_none_or_malformed(self):
        self.assertEqual(config.validate_and_sanitize(None), config.get_default_config())
        self.assertEqual(config.validate_and_sanitize("not a dict"), config.get_default_config())


class TestConfigMigrationAndPersistence(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.cfg_file = os.path.join(self.test_dir, "test_config.json")

    def tearDown(self):
        if os.path.exists(self.cfg_file):
            try:
                os.remove(self.cfg_file)
            except OSError:
                pass
        try:
            os.rmdir(self.test_dir)
        except OSError:
            pass

    def test_migrate_legacy_flat_dict(self):
        legacy = {"port": 9000, "mic": "2"}
        migrated = config.migrate_legacy_dict(legacy)
        self.assertEqual(migrated["server"]["port"], 9000)
        self.assertEqual(migrated["audio"]["device_id"], "2")
        self.assertEqual(migrated["engine"]["profile"], "fast")
        self.assertEqual(migrated["version"], 1)

    def test_atomic_save_and_load(self):
        cfg = config.get_default_config()
        cfg["ui"]["box_width_pct"] = 75
        cfg["audio"]["device_id"] = "test-mic"

        ok = config.save_config(cfg, self.cfg_file)
        self.assertTrue(ok)
        self.assertTrue(os.path.isfile(self.cfg_file))

        loaded = config.load_config(self.cfg_file)
        self.assertEqual(loaded["ui"]["box_width_pct"], 75)
        self.assertEqual(loaded["audio"]["device_id"], "test-mic")

    def test_load_nonexistent_returns_defaults(self):
        loaded = config.load_config(os.path.join(self.test_dir, "nonexistent.json"))
        self.assertEqual(loaded, config.get_default_config())

    def test_apply_patch(self):
        cfg = config.get_default_config()
        updated, changed = config.apply_patch(cfg, "ui", {"box_width_pct": 82, "difficult_style": "glow"})
        self.assertTrue(changed)
        self.assertEqual(updated["ui"]["box_width_pct"], 82)
        self.assertEqual(updated["ui"]["difficult_style"], "glow")
        # Adjacent domains unchanged
        self.assertEqual(updated["engine"]["profile"], "fast")

    def test_apply_patch_invalid_domain(self):
        cfg = config.get_default_config()
        updated, changed = config.apply_patch(cfg, "nonexistent", {"key": "val"})
        self.assertFalse(changed)
        self.assertEqual(updated, cfg)


if __name__ == "__main__":
    unittest.main()
