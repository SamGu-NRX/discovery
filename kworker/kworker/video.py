"""Video jobs: download, probe, transcript, key frames, and a vision read.

Each step is a derivation of the video's sha, so a rerun reads them back
without touching the file, and the file itself comes from R2 (never the
origin) when a step does need it.
"""

from __future__ import annotations

import json
import math
import re
import shutil
import subprocess
from pathlib import Path

from . import models
from .api import canonical_json
from .ctx import Ctx
from .media import fetch_media, local_copy
from .models import cached_code

PROBE_V = "ffprobe-json+v1"
FRAMES_V = "frames-v1(scene>0.3,max8,fill5s)"
WHISPER = ("faster-whisper/large-v3-turbo", "whisper-v1")
MAX_FRAMES = 8
SCENE = 0.3
VIDEO_SCHEMA = {
    "type": "object",
    "properties": {
        "description": {"type": "string"},
        "scenes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"t": {"type": "number"}, "description": {"type": "string"}, "on_screen_text": {"type": "string"}},
                "required": ["t", "description", "on_screen_text"],
            },
        },
    },
    "required": ["description", "scenes"],
}
_whisper = {}


def _tool(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise RuntimeError(f"{name} is not on PATH (kworker/README.md lists the tools it needs)")
    return path


def probe(ctx: Ctx, media: dict) -> dict:
    def compute():
        out = subprocess.run(
            [_tool("ffprobe"), "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(local_copy(ctx, media))],
            capture_output=True, text=True, check=True,
        ).stdout
        return canonical_json(json.loads(out)).encode("utf-8"), "application/json"

    sha, _ = cached_code(ctx, "probe", media["sha256"], "code/ffprobe", PROBE_V, compute)
    p = ctx.api.get_json(sha)
    v = next((s for s in p["streams"] if s.get("codec_type") == "video"), {})
    return {
        "duration_s": float(p["format"].get("duration") or 0),
        "width": v.get("width"),
        "height": v.get("height"),
        "has_audio": any(s.get("codec_type") == "audio" for s in p["streams"]),
        "probe_sha": sha,
    }


def transcribe(ctx: Ctx, media: dict) -> dict:
    def compute():
        audio = _audio(local_copy(ctx, media))
        try:
            segments, info = _whisper_model(ctx).transcribe(audio, vad_filter=True, beam_size=5)
            segs = list(segments)
        except RuntimeError as e:
            # A CUDA library that loads but fails on first use surfaces here,
            # not at model load.
            if _whisper.get("device") != "cuda":
                raise
            print(f"[kworker] whisper on CUDA failed ({e}); using the CPU")
            _whisper.clear()
            segments, info = _whisper_model(ctx, cpu=True).transcribe(audio, vad_filter=True, beam_size=5)
            segs = list(segments)
        out = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segs]
        doc = {"language": info.language, "language_probability": round(info.language_probability, 3), "segments": out, "device": _whisper["device"]}
        return canonical_json(doc).encode("utf-8"), "application/json"

    sha, _ = cached_code(ctx, "transcribe", media["sha256"], WHISPER[0], WHISPER[1], compute)
    return {**ctx.api.get_json(sha), "output_sha": sha, "by": {"provider": "faster-whisper", "model": "large-v3-turbo", "prompt_v": WHISPER[1]}}


def _audio(path: Path):
    """16 kHz mono float32 samples, decoded by the system ffmpeg. faster-whisper
    1.2.1's own decoder passes PyAV an argument PyAV 19 no longer accepts."""
    import numpy as np

    raw = subprocess.run([_tool("ffmpeg"), "-nostdin", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", "16000", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def _cuda_dll_dirs() -> None:
    """The nvidia-cublas and nvidia-cudnn wheels put their DLLs where Windows
    does not look, and ctranslate2 loads them lazily, so their folders go on
    the search path before the model loads."""
    import os
    import site

    if os.name != "nt":
        return
    for base in site.getsitepackages():
        for sub in ("cublas", "cudnn", "cuda_nvrtc"):
            d = Path(base) / "nvidia" / sub / "bin"
            if d.is_dir():
                os.add_dll_directory(str(d))
                os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")


def _whisper_model(ctx: Ctx, cpu: bool = False):
    if "m" not in _whisper:
        from faster_whisper import WhisperModel

        root = str(ctx.cfg.model_cache / "whisper")
        if not cpu:
            _cuda_dll_dirs()
            try:
                _whisper.update(m=WhisperModel("large-v3-turbo", device="cuda", compute_type="float16", download_root=root), device="cuda")
                return _whisper["m"]
            except (RuntimeError, ValueError, OSError) as e:
                print(f"[kworker] no CUDA for whisper ({e}); using the CPU")
        _whisper.update(m=WhisperModel("large-v3-turbo", device="cpu", compute_type="int8", download_root=root), device="cpu")
    return _whisper["m"]


def key_frames(ctx: Ctx, media: dict, duration: float) -> list[dict]:
    def compute():
        src = local_copy(ctx, media)
        out_dir = ctx.scratch / f"frames-{media['sha256'][:12]}"
        out_dir.mkdir(exist_ok=True)
        r = subprocess.run(
            [_tool("ffmpeg"), "-hide_banner", "-nostdin", "-i", str(src), "-vf", f"select='eq(n,0)+gt(scene,{SCENE})',showinfo,scale='min(1280,iw)':-2",
             "-fps_mode", "vfr", "-q:v", "3", str(out_dir / "f%03d.jpg")],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            raise RuntimeError(f"ffmpeg scene frames failed: {r.stderr[-300:]}")
        times = [float(t) for t in re.findall(r"pts_time:([\d.]+)", r.stderr)]
        files = sorted(out_dir.glob("f*.jpg"))
        frames = list(zip(times, files))
        if len(frames) > MAX_FRAMES:
            step = len(frames) / MAX_FRAMES
            frames = [frames[int(i * step)] for i in range(MAX_FRAMES)]
        want = min(MAX_FRAMES, max(1, math.ceil(duration / 5)))
        if len(frames) < want:
            # Few cuts (a screen recording, one long shot): fill with evenly
            # spaced frames, about one per 5 seconds, up to MAX_FRAMES in all.
            have = {round(t) for t, _ in frames}
            for k in range(1, want):
                t = round(duration * k / want, 2)
                if round(t) in have or len(frames) >= want:
                    continue
                dest = out_dir / f"even{k:02d}.jpg"
                subprocess.run([_tool("ffmpeg"), "-hide_banner", "-nostdin", "-ss", str(t), "-i", str(src), "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "3", str(dest)],
                               capture_output=True, check=True)
                frames.append((t, dest))
            frames.sort(key=lambda x: x[0])
        listed = [{"t": round(t, 2), "sha256": ctx.api.put_file(f, "image/jpeg")} for t, f in frames]
        return canonical_json({"frames": listed}).encode("utf-8"), "application/json"

    sha, _ = cached_code(ctx, "key_frames", media["sha256"], "code/ffmpeg", FRAMES_V, compute)
    return ctx.api.get_json(sha)["frames"]


def video_job(ctx: Ctx, payload: dict) -> dict:
    media = fetch_media(ctx, payload["source_url"])
    info = probe(ctx, media)
    if info["has_audio"]:
        transcript = transcribe(ctx, media)
    else:
        transcript = {"language": None, "segments": [], "note": "no audio stream", "by": None}
    frames = key_frames(ctx, media, info["duration_s"])

    def build(cap: dict):
        if cap["prompt_v"] == "video-read-v1":
            return models.Request(text=models.prompt("video-read-v1"), inputs=[(media["sha256"], media["mime"])], schema=VIDEO_SCHEMA, max_output_tokens=6000)
        if cap["prompt_v"] == "video-frames-v1" and frames:
            labels = "\n".join(f"Frame {i + 1}: t={f['t']}s" for i, f in enumerate(frames))
            said = "\n".join(f"[{s['start']:.1f}-{s['end']:.1f}] {s['text']}" for s in transcript["segments"])
            text = models.prompt("video-frames-v1").replace("{frames}", labels).replace("{transcript}", said)
            return models.Request(text=text, inputs=[(f["sha256"], "image/jpeg") for f in frames], schema=VIDEO_SCHEMA, max_output_tokens=6000)
        return None

    read = models.run(ctx, "video_read", build)
    return {
        "sha256": media["sha256"],
        "mime": media["mime"],
        "source_url": payload["source_url"],
        "post_id": payload["post_id"],
        "probe": info,
        "transcript": transcript,
        "key_frames": frames,
        "read": {**json.loads(read.output), "by": read.by.as_dict(), "output_sha": read.output_sha},
    }
