#!/usr/bin/env bash
set -euo pipefail

AUDIO_DIR="${1:-./output/audio}"
RECORDINGS_DIR="${2:-./output/recordings}"
FINAL_OUTPUT="${3:-./output/final_demo.mp4}"
CONCAT_FILE="$AUDIO_DIR/audio_list.txt"
MASTER_AUDIO="$AUDIO_DIR/master_narration.wav"
POINTER_FILE="$RECORDINGS_DIR/latest_recording.txt"
SYNC_MANIFEST="${SYNC_MANIFEST:-$AUDIO_DIR/../sync_manifest.json}"
SYNC_AUDIO_LIST="$AUDIO_DIR/sync_audio_list.txt"
TRIM_START=0

# Windows usually has `python` but no working `python3` (or only the Store stub), so probe instead of assuming.
if [[ -z "${PYTHON:-}" ]]; then
  for candidate in python3 python; do
    if "$candidate" -c 'import wave' >/dev/null 2>&1; then
      PYTHON="$candidate"
      break
    fi
  done
fi

mkdir -p "$(dirname "$MASTER_AUDIO")" "$(dirname "$FINAL_OUTPUT")"
rm -f "$SYNC_AUDIO_LIST" "$AUDIO_DIR/sync_trim_start.txt"

if [[ ! -f "$CONCAT_FILE" ]]; then
  printf 'Error: Missing %s\n' "$CONCAT_FILE" >&2
  exit 1
fi

if [[ -f "$SYNC_MANIFEST" ]]; then
  "${PYTHON:?No working python3 or python found; set PYTHON}" - "$SYNC_MANIFEST" "$AUDIO_DIR" "$SYNC_AUDIO_LIST" <<'PY'
import json
import sys
import wave
from pathlib import Path

manifest_path, audio_dir, list_path = [Path(value).resolve() for value in sys.argv[1:]]
data = json.loads(manifest_path.read_text(encoding='utf-8'))
events = sorted(data.get('events', []), key=lambda event: event['start_sec'])
if not events:
    sys.exit(0)

first_file = Path(events[0]['file'])
with wave.open(str(first_file), 'rb') as source:
    channels = source.getnchannels()
    width = source.getsampwidth()
    rate = source.getframerate()

cursor = float(events[0]['start_sec'])
files = []
for index, event in enumerate(events):
    start = float(event['start_sec'])
    gap = max(0.0, start - cursor)
    if gap > 0.02:
        silence = audio_dir / f'sync_silence_{index:03d}.wav'
        with wave.open(str(silence), 'wb') as target:
            target.setnchannels(channels)
            target.setsampwidth(width)
            target.setframerate(rate)
            target.writeframes(b'\0' * int(gap * rate) * channels * width)
        files.append(silence)
    files.append(Path(event['file']))
    # Advance by the clip's real length, not end_sec: the recorder holds each scene a little past the clip,
    # and that hold must become silence before the next cue or every later clip starts early (drift accumulates).
    with wave.open(event['file'], 'rb') as clip:
        cursor = max(cursor, start + clip.getnframes() / clip.getframerate())

with list_path.open('w', encoding='utf-8') as handle:
    for file_path in files:
        escaped = str(file_path).replace("'", "'\\''")
        handle.write(f"file '{escaped}'\n")
(audio_dir / 'sync_trim_start.txt').write_text(str(events[0]['start_sec']), encoding='utf-8')
PY
  if [[ -f "$AUDIO_DIR/sync_trim_start.txt" ]]; then
    IFS= read -r TRIM_START < "$AUDIO_DIR/sync_trim_start.txt" || true
  fi
fi

if [[ -s "$SYNC_AUDIO_LIST" ]]; then
  CONCAT_FILE="$SYNC_AUDIO_LIST"
fi

printf '==> Step 1: Concatenating audio tracks\n'
ffmpeg -f concat -safe 0 -i "$CONCAT_FILE" -c copy "$MASTER_AUDIO" -y

printf '==> Step 2: Locating screen recording\n'
LATEST_VIDEO=""
if [[ -f "$POINTER_FILE" ]]; then
  IFS= read -r RECORDING_PATH < "$POINTER_FILE" || true
  if [[ -n "${RECORDING_PATH:-}" ]]; then
    if [[ "$RECORDING_PATH" != /* ]]; then
      RECORDING_PATH="$RECORDINGS_DIR/$RECORDING_PATH"
    fi
    if [[ -f "$RECORDING_PATH" ]]; then
      LATEST_VIDEO="$RECORDING_PATH"
    fi
  fi
fi
if [[ -z "$LATEST_VIDEO" ]]; then
  LATEST_VIDEO=$(ls -t "$RECORDINGS_DIR"/*.webm 2>/dev/null | head -n 1 || true)
fi
if [[ -z "$LATEST_VIDEO" || ! -f "$LATEST_VIDEO" ]]; then
  printf 'Error: No recordings found in %s\n' "$RECORDINGS_DIR" >&2
  exit 1
fi
printf 'Using video source: %s\n' "$LATEST_VIDEO"

printf '==> Step 3: Muxing audio and video\n'
AUDIO_DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$MASTER_AUDIO")
VIDEO_INPUT_ARGS=(-i "$LATEST_VIDEO")
if [[ "$TRIM_START" != "0" && "$TRIM_START" != "0.0" ]]; then
  VIDEO_INPUT_ARGS=(-ss "$TRIM_START" -i "$LATEST_VIDEO")
  printf 'Trimming %.3fs before the first narration cue\n' "$TRIM_START"
fi
ffmpeg "${VIDEO_INPUT_ARGS[@]}" -i "$MASTER_AUDIO" \
  -c:v libx264 -preset medium -crf 20 \
  -vf "scale=1920:1080:flags=lanczos" \
  -c:a aac -b:a 192k \
  -pix_fmt yuv420p \
  -t "$AUDIO_DURATION" \
  "$FINAL_OUTPUT" -y

if [[ ! -s "$FINAL_OUTPUT" ]]; then
  printf 'Error: Final output was not created or is empty: %s\n' "$FINAL_OUTPUT" >&2
  exit 1
fi
printf '==> Pipeline complete: %s\n' "$FINAL_OUTPUT"
