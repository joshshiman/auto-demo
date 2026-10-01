"""Slow synthesized narration down: lengthen the pauses inside each cue and apply a gentle tempo reduction.

Raw TTS tends to read wall-to-wall. Run this after voice_clone.py and before recording; it rewrites each cue
WAV and updates duration_sec in the timing manifest, so the recorder holds each scene for the paced length.

The untouched clips are kept in --raw-dir (copied there on the first run) and every run starts from them,
so re-running with different settings never compounds. To redo one cue, write its new WAV into --raw-dir
and run this again. Requires ffmpeg on PATH.
"""
import argparse
import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--audio-dir", default="./output/audio", help="Cue WAVs to pace (rewritten in place)")
    parser.add_argument("--raw-dir", default=None, help="Untouched TTS clips (default: <audio-dir>_raw)")
    parser.add_argument("--manifest-path", default="./output/timing_manifest.json", help="Timing manifest to update")
    parser.add_argument("--tempo", type=float, default=0.95, help="Speech tempo; <1 is slower, pitch preserved")
    parser.add_argument("--long-pause", type=float, default=0.25, help="Silence (s) treated as a sentence break")
    parser.add_argument("--long-extra", type=float, default=0.40, help="Extra silence (s) added to sentence breaks")
    parser.add_argument("--short-pause", type=float, default=0.10, help="Silence (s) treated as a comma-length break")
    parser.add_argument("--short-extra", type=float, default=0.12, help="Extra silence (s) added to short breaks")
    parser.add_argument("--silent-db", type=float, default=-38, help="Frame level (dB below peak) counted as silence")
    return parser.parse_args()


def stretch_pauses(x, sr, args):
    """Insert extra silence into the middle of every internal pause; leading/trailing silence is untouched."""
    hop = int(sr * 0.01)
    frames = len(x) // hop
    if frames == 0:
        return x
    rms = np.sqrt(np.mean(x[:frames * hop].reshape(frames, hop, *x.shape[1:]) ** 2, axis=tuple(range(1, x.ndim + 1))) + 1e-12)
    silent = 20 * np.log10(rms / rms.max()) < args.silent_db
    pieces, last, i = [], 0, 0
    while i < frames:
        if not silent[i]:
            i += 1
            continue
        j = i
        while j < frames and silent[j]:
            j += 1
        run = (j - i) * 0.01
        extra = args.long_extra if run >= args.long_pause else args.short_extra if run >= args.short_pause else 0
        if i > 0 and j < frames and extra:
            mid = (i + j) // 2 * hop
            pieces += [x[last:mid], np.zeros((int(extra * sr),) + x.shape[1:], x.dtype)]
            last = mid
        i = j
    pieces.append(x[last:])
    return np.concatenate(pieces)


def main():
    args = parse_args()
    audio_dir = Path(args.audio_dir)
    raw_dir = Path(args.raw_dir) if args.raw_dir else audio_dir.with_name(audio_dir.name + "_raw")
    manifest_path = Path(args.manifest_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not raw_dir.exists():
        raw_dir.mkdir(parents=True)
        for cue_id in manifest:
            shutil.copy2(audio_dir / f"{cue_id}.wav", raw_dir / f"{cue_id}.wav")

    for cue_id, item in manifest.items():
        x, sr = sf.read(raw_dir / f"{cue_id}.wav", dtype="float32")
        stretched = audio_dir / f"_{cue_id}_stretched.wav"
        sf.write(stretched, stretch_pauses(x, sr, args), sr)
        target = audio_dir / f"{cue_id}.wav"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(stretched), "-filter:a", f"atempo={args.tempo}", str(target)], check=True)
        stretched.unlink()
        before = item["duration_sec"]
        item["duration_sec"] = round(sf.info(target).duration, 3)
        print(f"{cue_id}: {before:6.2f}s -> {item['duration_sec']:6.2f}s")
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Total narration: {sum(v['duration_sec'] for v in manifest.values()):.1f}s")


if __name__ == "__main__":
    main()
