const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");
const ffmpegPath = require("ffmpeg-static");

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;

const MODAL_TRANSCRIBE_URL =
  "https://bassamshukri--sermon-fast-transcriber-transcribe.modal.run";

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^\w.\-]/g, "_");
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: {
    // Good for long audio files. Very large videos still need direct cloud upload later.
    fileSize: 1024 * 1024 * 200,
  },
});

const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".flac",
  ".wma",
]);

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".avi",
  ".m4v",
]);

function getExtension(filename) {
  return path.extname(filename || "").toLowerCase();
}

function isAudioFile(filename) {
  return AUDIO_EXTENSIONS.has(getExtension(filename));
}

function isVideoFile(filename) {
  return VIDEO_EXTENSIONS.has(getExtension(filename));
}

function buildArticleFromTranscript(transcript, language = "en") {
  const cleaned = (transcript || "").trim();

  if (!cleaned) {
    return "No article could be generated because the transcript is empty.";
  }

  if (language === "ar") {
    return [
      "## مقال العظة",
      "",
      "تم إنشاء هذا المقال من النص المستخرج من الملف المرفوع.",
      "",
      "### الفكرة الرئيسية",
      cleaned,
      "",
      "### تأمل",
      "تشجع هذه العظة على الإيمان، والتأمل، وتطبيق كلمة الله في الحياة اليومية.",
    ].join("\n");
  }

  return [
    "## Sermon Article",
    "",
    "This article was generated from the uploaded sermon transcript.",
    "",
    "### Main Message",
    cleaned,
    "",
    "### Reflection",
    "This sermon encourages reflection, faith, and practical application in everyday life.",
  ].join("\n");
}

async function runFfmpeg(args) {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static binary not found.");
  }

  try {
    await execFileAsync(ffmpegPath, args, {
      maxBuffer: 1024 * 1024 * 50,
    });
  } catch (error) {
    const stderr = error.stderr || error.message || "Unknown ffmpeg error.";
    throw new Error(`ffmpeg failed: ${stderr}`);
  }
}

async function splitMediaIntoChunks(inputPath, chunkDir, chunkSeconds = 300) {
  fs.mkdirSync(chunkDir, { recursive: true });

  const chunkPattern = path.join(chunkDir, "chunk_%03d.wav");

  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    "-f",
    "segment",
    "-segment_time",
    String(chunkSeconds),
    chunkPattern,
  ]);

  const chunkFiles = fs
    .readdirSync(chunkDir)
    .filter((file) => file.endsWith(".wav"))
    .sort()
    .map((file) => path.join(chunkDir, file));

  if (chunkFiles.length === 0) {
    throw new Error("No audio chunks were created.");
  }

  return chunkFiles;
}

async function transcribeChunk(chunkPath, language = "auto") {
  const audioBuffer = fs.readFileSync(chunkPath);
  const audioBase64 = audioBuffer.toString("base64");

  const response = await fetch(MODAL_TRANSCRIBE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filename: path.basename(chunkPath),
      audio_base64: audioBase64,
      language,
    }),
  });

  const data = await response.json();

  if (!response.ok || !data.success) {
    throw new Error(data.error || "Chunk transcription failed.");
  }

  return data;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let currentIndex = 0;

  async function runner() {
    while (true) {
      const index = currentIndex++;
      if (index >= items.length) break;
      results[index] = await worker(items[index], index);
    }
  }

  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runner()
  );

  await Promise.all(runners);
  return results;
}

async function transcribeLongMediaInParallel(inputPath, originalName, language = "auto") {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sermon-chunks-"));
  const chunkDir = path.join(tempRoot, "chunks");

  try {
    const chunkFiles = await splitMediaIntoChunks(inputPath, chunkDir, 300);

    const chunkResults = await mapWithConcurrency(
      chunkFiles,
      4,
      async (chunkPath) => transcribeChunk(chunkPath, language)
    );

    const transcript = chunkResults
      .map((result) => result.transcript || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    const first = chunkResults[0] || {};
    const detectedLanguage = first.language || "en";
    const totalDuration = chunkResults.reduce(
      (sum, result) => sum + (Number(result.duration) || 0),
      0
    );

    return {
      success: true,
      filename: originalName,
      source_type: isVideoFile(originalName) ? "video" : "audio",
      transcript,
      language: detectedLanguage,
      requested_language: language,
      duration: totalDuration,
      chunk_count: chunkFiles.length,
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "sermon-to-article-backend",
  });
});

app.post("/convert", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: "No audio or video file uploaded.",
      });
    }

    const uploadedPath = req.file.path;
    const originalName = req.file.originalname;
    const selectedLanguage = req.body.language || "auto";
    const fileExt = getExtension(originalName);

    if (!isAudioFile(originalName) && !isVideoFile(originalName)) {
      return res.status(400).json({
        error: `Unsupported file type: ${fileExt || "unknown"}`,
      });
    }

    let result;

    // For audio and manageable videos, do chunking + parallel transcription.
    result = await transcribeLongMediaInParallel(
      uploadedPath,
      originalName,
      selectedLanguage
    );

    const article = buildArticleFromTranscript(
      result.transcript,
      result.language
    );

    return res.json({
      success: true,
      filename: result.filename,
      source_type: result.source_type,
      transcript: result.transcript,
      article,
      language: result.language,
      requested_language: result.requested_language,
      duration: result.duration,
      chunk_count: result.chunk_count,
    });
  } catch (error) {
    console.error("Convert error:", error);
    return res.status(500).json({
      error: "Server failed to process the sermon.",
      details: error.message,
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});