'use strict';
require('dotenv').config();

const express = require('express');
const path = require('path');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function extractVideoId(urlOrId) {
  const m =
    urlOrId.match(
      /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/i
    ) || urlOrId.match(/^([0-9A-Za-z_-]{11})$/);
  if (m) return m[1];
  throw new Error('Could not extract a valid YouTube video ID from: ' + urlOrId);
}

function runYtDlp(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile('yt-dlp', args, { timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

// --- Captions mode ---

async function fetchTranscript(videoId, lang = 'en') {
  const tmpId = crypto.randomBytes(8).toString('hex');
  const tmpBase = path.join(os.tmpdir(), `yt_transcript_${tmpId}`);

  const args = [
    '--write-auto-sub',
    '--write-sub',
    '--sub-lang', lang,
    '--skip-download',
    '--sub-format', 'json3',
    '--no-playlist',
    '-o', tmpBase,
    `https://www.youtube.com/watch?v=${videoId}`,
  ];

  try {
    await runYtDlp(args);
  } catch (err) {
    const subFile = `${tmpBase}.${lang}.json3`;
    if (!fs.existsSync(subFile)) {
      throw new Error('No transcript available for this video. ' + err.message.split('\n')[0]);
    }
  }

  const dir = os.tmpdir();
  const files = fs.readdirSync(dir).filter(f => f.startsWith(`yt_transcript_${tmpId}`) && f.endsWith('.json3'));

  if (!files.length) {
    throw new Error('No transcript file was generated. The video may not have captions.');
  }

  const subPath = path.join(dir, files[0]);
  const langCode = files[0].replace(`yt_transcript_${tmpId}.`, '').replace('.json3', '');

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(subPath, 'utf8'));
  } finally {
    fs.unlink(subPath, () => {});
  }

  const events = (parsed.events || []).filter(e => e.segs);
  if (!events.length) {
    throw new Error('Transcript data was empty.');
  }

  const lines = events
    .map(e => e.segs.map(s => (s.utf8 || '').replace(/\n/g, ' ')).join('').trim())
    .filter(Boolean);

  return {
    transcript: lines.join('\n'),
    segments: lines.length,
    language: langCode,
  };
}

// --- Diarization mode (Fast Transcription API) ---

function downloadAudio(videoId, outPath) {
  return new Promise((resolve, reject) => {
    const ytdlp = spawn('yt-dlp', [
      '-f', 'bestaudio',
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '5',
      '--no-playlist',
      '-o', outPath,
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);
    ytdlp.stderr.resume();
    ytdlp.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp exited with code ${code}`));
    });
    ytdlp.on('error', err => reject(new Error('yt-dlp error: ' + err.message)));
  });
}

function parseFastTranscript(result) {
  const phrases = result.phrases || [];
  if (!phrases.length) throw new Error('Azure returned no recognized phrases');

  const speakerMap = {};
  let speakerCount = 0;

  return phrases.map(phrase => {
    const text = (phrase.text || '').trim();
    if (!text) return null;

    const speakerId = phrase.speaker ?? 'Unknown';
    if (speakerId === 'Unknown') return `Unknown: ${text}`;
    if (!speakerMap[speakerId]) {
      speakerCount++;
      speakerMap[speakerId] = `Speaker ${speakerCount}`;
    }
    return `${speakerMap[speakerId]}: ${text}`;
  }).filter(Boolean).join('\n');
}

async function fastDiarize(videoId) {
  const tmpId   = crypto.randomBytes(8).toString('hex');
  const tmpPath = path.join(os.tmpdir(), `yt_batch_${tmpId}`);

  try {
    await downloadAudio(videoId, tmpPath);

    const audioPath = `${tmpPath}.mp3`;
    if (!fs.existsSync(audioPath)) throw new Error('yt-dlp did not produce an mp3 output file');

    const region   = process.env.AZURE_SPEECH_REGION;
    const key      = process.env.AZURE_SPEECH_KEY;
    const endpoint = `https://${region}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15`;

    const audioBytes = fs.readFileSync(audioPath);
    const form = new FormData();
    form.append('audio', new Blob([audioBytes], { type: 'audio/mpeg' }), `${tmpId}.mp3`);
    form.append('definition', JSON.stringify({
      locales: ['en-US'],
      diarization: { enabled: true, maxSpeakers: 4 },
    }));

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': key },
      body: form,
    });
    if (!res.ok) throw new Error(`Fast transcription failed: ${res.status} ${await res.text()}`);

    const result = await res.json();
    return parseFastTranscript(result);
  } finally {
    fs.unlink(`${tmpPath}.mp3`, () => {});
  }
}

// --- Routes ---

app.post('/transcript', async (req, res) => {
  const { url, lang, mode } = req.body;
  if (!url?.trim()) {
    return res.status(400).json({ error: 'Missing "url" field.' });
  }

  let videoId;
  try {
    videoId = extractVideoId(url.trim());
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!mode || mode === 'captions') {
    try {
      const result = await fetchTranscript(videoId, lang || 'en');
      return res.json({ ...result, videoId });
    } catch (err) {
      return res.status(502).json({ error: err.message || 'Failed to fetch transcript.' });
    }
  }

  if (mode === 'batch') {
    if (!process.env.AZURE_SPEECH_KEY || !process.env.AZURE_SPEECH_REGION) {
      return res.status(500).json({ error: 'Azure Speech credentials not configured.' });
    }

    try {
      const transcript = await fastDiarize(videoId);
      return res.json({ transcript, videoId, language: 'en-US', mode: 'batch' });
    } catch (err) {
      return res.status(502).json({ error: err.message || 'Diarization failed.' });
    }
  }

  return res.status(400).json({ error: `Unknown mode: "${mode}". Use "captions" or "batch".` });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`YouTube Transcript server running at http://localhost:${PORT}`);
});
