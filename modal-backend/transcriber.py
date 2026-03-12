import base64
import os
import subprocess
import tempfile

import modal
from fastapi import Body
from faster_whisper import WhisperModel

app = modal.App("sermon-fast-transcriber")

image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.1-cudnn-devel-ubuntu22.04",
        add_python="3.11",
    )
    .apt_install("ffmpeg")
    .pip_install(
        "fastapi",
        "faster-whisper",
    )
)

MODEL_NAME = "turbo"

VIDEO_EXTENSIONS = {
    ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v",
}

AUDIO_EXTENSIONS = {
    ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".wma",
}


def is_video_file(filename: str) -> bool:
    return os.path.splitext(filename)[1].lower() in VIDEO_EXTENSIONS


def is_audio_file(filename: str) -> bool:
    return os.path.splitext(filename)[1].lower() in AUDIO_EXTENSIONS


def has_audio_stream(input_path: str) -> bool:
    command = [
        "ffprobe",
        "-v", "error",
        "-select_streams", "a",
        "-show_entries", "stream=codec_type",
        "-of", "default=noprint_wrappers=1:nokey=1",
        input_path,
    ]
    result = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return result.returncode == 0 and "audio" in result.stdout.lower()


def convert_media_to_wav(input_path: str, output_path: str) -> None:
    command = [
        "ffmpeg",
        "-y",
        "-i",
        input_path,
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-c:a", "pcm_s16le",
        output_path,
    ]

    result = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg conversion failed: {result.stderr}")


def normalize_language(language_value):
    if not language_value:
        return None

    value = str(language_value).strip().lower()

    if value in {"auto", "detect", "auto-detect", "autodetect"}:
        return None

    if value in {"english", "en"}:
        return "en"

    if value in {"arabic", "ar"}:
        return "ar"

    return value


@app.function(
    image=image,
    gpu="A10G",
    cpu=4,
    memory=16384,
    scaledown_window=300,
    timeout=60 * 20,
)
@modal.fastapi_endpoint(method="POST")
def transcribe(payload: dict = Body(...)):
    try:
        media_b64 = payload.get("audio_base64") or payload.get("media_base64")
        filename = payload.get("filename", "media.wav")
        selected_language = normalize_language(payload.get("language"))

        if not media_b64:
            return {
                "success": False,
                "error": "audio_base64 or media_base64 is required"
            }

        media_bytes = base64.b64decode(media_b64)

        with tempfile.TemporaryDirectory() as tmpdir:
            input_path = os.path.join(tmpdir, filename)

            with open(input_path, "wb") as f:
                f.write(media_bytes)

            if not has_audio_stream(input_path):
                return {
                    "success": False,
                    "error": "This file does not contain an audio stream."
                }

            wav_path = os.path.join(tmpdir, "converted_audio.wav")

            if is_video_file(filename):
                source_type = "video"
            elif is_audio_file(filename):
                source_type = "audio"
            else:
                source_type = "unknown"

            convert_media_to_wav(input_path, wav_path)

            model = WhisperModel(
                MODEL_NAME,
                device="cuda",
                compute_type="float16",
            )

            segments, info = model.transcribe(
                wav_path,
                vad_filter=True,
                beam_size=1,
                language=selected_language,
            )

            transcript = " ".join(
                segment.text.strip() for segment in segments if segment.text.strip()
            ).strip()

            return {
                "success": True,
                "source_type": source_type,
                "language": info.language,
                "requested_language": selected_language or "auto",
                "duration": info.duration,
                "transcript": transcript,
            }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
        }