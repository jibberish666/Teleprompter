#!/usr/bin/env python3
"""Simulate live streaming word alignment against an audio recording or text."""
import argparse
import os
import sys

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../.."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import aligner


def simulate_audio_file(audio_path, script_text=None, model_name="base.en"):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper is required for audio simulation. Run inside .venv.")
        sys.exit(1)

    print(f"\n[Testing {audio_path}]")
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(audio_path, beam_size=1, word_timestamps=True)

    extracted_words = []
    for s in segments:
        for w in (s.words or []):
            extracted_words.append(w.word.strip())

    if not extracted_words:
        print("  Error: No words transcribed from audio.")
        return False

    if script_text:
        script_words = script_text.split()
    else:
        script_words = list(extracted_words)

    norm_asr = [aligner.normalize(w) for w in extracted_words]
    al = aligner.Aligner(script_words, window=5)

    all_matched = []
    # Simulate streaming 2 words per tick
    for idx in range(0, len(norm_asr), 2):
        chunk = norm_asr[idx : idx + 2]
        m = al.align(chunk)
        all_matched.extend(m)

    coverage = len(all_matched) / len(script_words) * 100
    print(f"  Script word count: {len(script_words)}")
    print(f"  ASR token count  : {len(norm_asr)}")
    print(f"  Words matched    : {len(all_matched)} ({coverage:.1f}%)")
    print(f"  Final cursor     : {al.cursor}/{len(script_words)}")

    success = coverage >= 95.0 and al.cursor == len(script_words)
    print(f"  Result           : {'PASS (100% Tracking)' if success else 'FAIL'}")
    return success


def main():
    parser = argparse.ArgumentParser(description="Simulate teleprompter session tracking")
    parser.add_argument("audio", nargs="?", default=None, help="Path to .webm or .wav audio file")
    parser.add_argument("--script", default=None, help="Path to script text file")
    args = parser.parse_args()

    script_text = None
    if args.script and os.path.isfile(args.script):
        with open(args.script, encoding="utf-8") as fh:
            script_text = fh.read()

    if args.audio:
        simulate_audio_file(args.audio, script_text=script_text)
    else:
        webm_files = [f for f in sorted(os.listdir(".")) if f.endswith(".webm")]
        if not webm_files:
            print("No .webm audio files found in current directory.")
            sys.exit(1)
        passed = 0
        for f in webm_files:
            if simulate_audio_file(f, script_text=script_text):
                passed += 1
        print(f"\nSummary: {passed}/{len(webm_files)} sessions passed.")


if __name__ == "__main__":
    main()
