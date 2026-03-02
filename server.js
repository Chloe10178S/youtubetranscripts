'use strict';

const express = require('express');
const path = require('path');
const { execFile } = require('child_process');
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
    // yt-dlp prints warnings to stderr even on success; check if file exists
    const subFile = `${tmpBase}.${lang}.json3`;
    if (!fs.existsSync(subFile)) {
      throw new Error('No transcript available for this video. ' + err.message.split('\n')[0]);
    }
  }

  // Find the downloaded subtitle file (yt-dlp may use .en.json3 or similar)
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

app.post('/transcript', async (req, res) => {
  const { url, lang } = req.body;
  if (!url?.trim()) {
    return res.status(400).json({ error: 'Missing "url" field.' });
  }

  let videoId;
  try {
    videoId = extractVideoId(url.trim());
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const result = await fetchTranscript(videoId, lang || 'en');
    return res.json({ ...result, videoId });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Failed to fetch transcript.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`YouTube Transcript server running at http://localhost:${PORT}`);
});
