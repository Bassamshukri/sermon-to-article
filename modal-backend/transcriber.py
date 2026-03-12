import base64
import os
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
        audio_b64 = payload.get("audio_base64")
        filename = payload.get("filename", "audio.wav")

        if not audio_b64:
            return {"success": False, "error": "audio_base64 is required"}

        audio_bytes = base64.b64decode(audio_b64)

        with tempfile.TemporaryDirectory() as tmpdir:
            input_path = os.path.join(tmpdir, filename)

            with open(input_path, "wb") as f:
                f.write(audio_bytes)

            model = WhisperModel(
                MODEL_NAME,
                device="cuda",
                compute_type="float16",
            )

            segments, info = model.transcribe(
                input_path,
                vad_filter=True,
                beam_size=1,
            )

            transcript = " ".join(
                segment.text.strip() for segment in segments if segment.text.strip()
            ).strip()

            return {
                "success": True,
                "language": info.language,
                "duration": info.duration,
                "transcript": transcript,
            }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
        }