import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 3000;

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

ffmpeg.setFfmpegPath(ffmpegPath);

const upload = multer({ dest: "uploads/" });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function splitAudioToChunks(inputPath, outputDir, chunkSeconds = 600) {
  return new Promise((resolve, reject) => {
    ensureDir(outputDir);

    ffmpeg(inputPath)
      .outputOptions([
        "-f segment",
        `-segment_time ${chunkSeconds}`,
        "-reset_timestamps 1"
      ])
      .audioCodec("libmp3lame")
      .format("segment")
      .save(path.join(outputDir, "chunk-%03d.mp3"))
      .on("end", () => {
        const files = fs
          .readdirSync(outputDir)
          .filter((file) => file.endsWith(".mp3"))
          .sort()
          .map((file) => path.join(outputDir, file));

        resolve(files);
      })
      .on("error", (err) => reject(err));
  });
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".aac") return "audio/aac";
  if (ext === ".ogg") return "audio/ogg";

  return "audio/mpeg";
}

async function transcribeChunk(filePath) {
  const mimeType = getMimeType(filePath);
  const base64Data = fs.readFileSync(filePath, { encoding: "base64" });

  const prompt = `
Transcribe this Christian sermon audio accurately.

Rules:
- Keep the original language exactly as spoken.
- If the sermon is Arabic, return Arabic transcript.
- Preserve Bible verses, names, and theological terms carefully.
- Do not summarize.
- Do not add explanations.
- Return transcript only.
`;

  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: [
      { text: prompt },
      {
        inlineData: {
          mimeType,
          data: base64Data
        }
      }
    ]
  });

  return (response.text || "").trim();
}

async function generateArticles(fullTranscript) {
  const prompt = `
You are helping a church turn a sermon into publishable content.

The sermon transcript may be in Arabic.

Please create all of the following:

1. ARABIC_TITLE
2. ARABIC_ARTICLE
3. ENGLISH_TITLE
4. ENGLISH_ARTICLE
5. SHORT_SUMMARY

Rules:
- Preserve the meaning of the sermon faithfully.
- If the transcript is Arabic, keep the Arabic article natural and clear.
- Write the English article as a proper translation/adaptation for English-speaking readers.
- Use headings and paragraphs.
- Remove filler words and spoken repetition in the articles.
- Keep Bible references, names, and theology accurate.
- Make the result suitable for a church website or newsletter.

Return exactly in this format:

ARABIC_TITLE:
...

ARABIC_ARTICLE:
...

ENGLISH_TITLE:
...

ENGLISH_ARTICLE:
...

SHORT_SUMMARY:
...

Transcript:
${fullTranscript}
`;

  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: [{ text: prompt }]
  });

  return (response.text || "").trim();
}

app.post("/api/sermon-to-article", upload.single("audio"), async (req, res) => {
  let uploadedFilePath = null;
  let chunksDir = null;

  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: "GEMINI_API_KEY is missing in .env"
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "No file uploaded"
      });
    }

    uploadedFilePath = req.file.path;
    chunksDir = path.join(__dirname, "uploads", `chunks-${Date.now()}`);

    const chunkFiles = await splitAudioToChunks(uploadedFilePath, chunksDir, 600);

    if (!chunkFiles.length) {
      return res.status(500).json({
        error: "No chunks were created from the uploaded file."
      });
    }

    const transcriptParts = [];

    for (let i = 0; i < chunkFiles.length; i++) {
      console.log(`Processing chunk ${i + 1} of ${chunkFiles.length}`);
      const text = await transcribeChunk(chunkFiles[i]);
      transcriptParts.push(text);
    }

    const fullTranscript = transcriptParts.join("\n\n");

    const articleBundle = await generateArticles(fullTranscript);

    res.json({
      transcript: fullTranscript,
      article: articleBundle
    });
  } catch (error) {
    console.error("SERVER ERROR:");
    console.error(error);

    res.status(500).json({
      error: error?.message || "Processing error"
    });
  } finally {
    try {
      if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
        fs.unlinkSync(uploadedFilePath);
      }

      if (chunksDir && fs.existsSync(chunksDir)) {
        const files = fs.readdirSync(chunksDir);
        for (const file of files) {
          fs.unlinkSync(path.join(chunksDir, file));
        }
        fs.rmdirSync(chunksDir);
      }
    } catch (cleanupError) {
      console.error("Cleanup error:", cleanupError);
    }
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});