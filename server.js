const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

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
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^\w.\-]/g, "_");
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const upload = multer({ storage });

function buildArticleFromTranscript(transcript) {
  const cleaned = transcript.trim();

  if (!cleaned) {
    return "No article could be generated because the transcript is empty.";
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
        error: "No audio file uploaded.",
      });
    }

    const uploadedPath = req.file.path;
    const originalName = req.file.originalname;

    const audioBuffer = fs.readFileSync(uploadedPath);
    const audioBase64 = audioBuffer.toString("base64");

    const modalResponse = await fetch(MODAL_TRANSCRIBE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filename: originalName,
        audio_base64: audioBase64,
      }),
    });

    const modalData = await modalResponse.json();

    if (!modalResponse.ok || !modalData.success) {
      return res.status(500).json({
        error: "Transcription failed.",
        details: modalData.error || "Unknown Modal error.",
      });
    }

    const transcript = modalData.transcript || "";
    const article = buildArticleFromTranscript(transcript);

    return res.json({
      success: true,
      filename: originalName,
      transcript,
      article,
      language: modalData.language,
      duration: modalData.duration,
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