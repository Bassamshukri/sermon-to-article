const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
    "This article was generated from the uploaded sermon.",
    "",
    "### Main Message",
    cleaned,
    "",
    "### Reflection",
    "This message encourages readers to reflect on the sermon and apply its lessons in daily life.",
  ].join("\n");
}

/*
  IMPORTANT:
  Right now this backend is set up to work online and prove the full flow.

  If you already have real Whisper / transcription logic from your old server.js,
  put that logic inside the convert route where the MOCK section is marked.

  For now, this version returns a working demo response so your frontend and backend
  are fully connected in the cloud.
*/

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

    // ===== MOCK / SAFE CLOUD TEST VERSION =====
    // Replace this block with your real transcription logic later.
    const transcript = `Transcript placeholder for "${originalName}". Your frontend and backend are connected successfully.`;
    const article = buildArticleFromTranscript(transcript);
    // ==========================================

    return res.json({
      success: true,
      filename: originalName,
      storedFile: path.basename(uploadedPath),
      transcript,
      article,
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
});v