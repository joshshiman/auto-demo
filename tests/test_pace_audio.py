"""Run with the skill venv: python tests/test_pace_audio.py"""
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from pace_audio import stretch_pauses  # noqa: E402

SR = 16000
ARGS = SimpleNamespace(long_pause=0.25, long_extra=0.40, short_pause=0.10, short_extra=0.12, silent_db=-38)


def tone(sec):
    return (0.5 * np.sin(np.linspace(0, 440 * 2 * np.pi * sec, int(SR * sec)))).astype(np.float32)


def silence(sec):
    return np.zeros(int(SR * sec), np.float32)


# speech, sentence break (0.4s), speech, comma (0.15s), speech, trailing silence (0.3s)
x = np.concatenate([tone(1), silence(0.4), tone(1), silence(0.15), tone(1), silence(0.3)])
y = stretch_pauses(x, SR, ARGS)
added = (len(y) - len(x)) / SR
assert abs(added - (0.40 + 0.12)) < 0.02, added  # long + short break stretched, trailing silence untouched

# leading silence is left alone too
lead = np.concatenate([silence(0.5), tone(1)])
assert len(stretch_pauses(lead, SR, ARGS)) == len(lead)

# stereo input keeps its channel count
stereo = np.stack([x, x], axis=1)
assert stretch_pauses(stereo, SR, ARGS).shape == (len(y), 2)
print("ok")
