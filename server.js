'use strict';
require('dotenv').config();

const express = require('express');
const path = require('path');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');

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

// --- Batch Diarization mode ---

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

async function uploadBlob(localPath, blobName) {
  const client = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
  const container = client.getContainerClient(process.env.AZURE_STORAGE_CONTAINER);
  const blob = container.getBlockBlobClient(blobName);
  await blob.uploadFile(localPath);

  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const accountName = connStr.match(/AccountName=([^;]+)/)?.[1];
  const accountKey  = connStr.match(/AccountKey=([^;]+)/)?.[1];
  if (!accountName || !accountKey) throw new Error('Could not parse storage account name/key from connection string');

  const cred = new StorageSharedKeyCredential(accountName, accountKey);
  const expiresOn = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const sas = generateBlobSASQueryParameters(
    { containerName: process.env.AZURE_STORAGE_CONTAINER, blobName, permissions: BlobSASPermissions.parse('r'), expiresOn },
    cred
  ).toString();

  return { sasUrl: `${blob.url}?${sas}`, blobClient: blob };
}

async function submitBatchJob(sasUrl) {
  const region = process.env.AZURE_SPEECH_REGION;
  const key    = process.env.AZURE_SPEECH_KEY;
  const endpoint = `https://${region}.api.cognitive.microsoft.com/speechtotext/v3.2/transcriptions`;

  const body = {
    contentUrls: [sasUrl],
    locale: 'en-US',
    displayName: `yt-batch-${Date.now()}`,
    properties: {
      diarizationEnabled: true,
      diarizationConfig: { minSpeakers: 1, maxSpeakers: 4 },
      wordLevelTimestampsEnabled: false,
      punctuationMode: 'DictatedAndAutomatic',
      channels: [0],
    },
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Batch job submit failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (!json.self) throw new Error('Batch job response missing self URL: ' + JSON.stringify(json));
  return json.self;
}

async function pollBatchJob(jobUrl, intervalMs = 5000, timeoutMs = 20 * 60 * 1000) {
  const key = process.env.AZURE_SPEECH_KEY;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs));
    const res = await fetch(jobUrl, { headers: { 'Ocp-Apim-Subscription-Key': key } });
    if (!res.ok) throw new Error(`Poll failed: ${res.status}`);
    const job = await res.json();

    if (job.status === 'Failed') throw new Error('Batch transcription job failed: ' + JSON.stringify(job.properties?.error));
    if (job.status !== 'Succeeded') continue;

    const filesRes = await fetch(job.links.files, { headers: { 'Ocp-Apim-Subscription-Key': key } });
    if (!filesRes.ok) throw new Error(`Fetching result files failed: ${filesRes.status}`);
    const files = await filesRes.json();

    const resultFile = files.values.find(f => f.kind === 'Transcription');
    if (!resultFile) throw new Error('No transcription result file found in batch job output');

    const resultRes = await fetch(resultFile.links.contentUrl);
    if (!resultRes.ok) throw new Error(`Fetching result content failed: ${resultRes.status}`);
    return await resultRes.json();
  }

  throw new Error('Batch transcription timed out after 20 minutes');
}

async function deleteBatchJob(jobUrl) {
  const key = process.env.AZURE_SPEECH_KEY;
  await fetch(jobUrl, { method: 'DELETE', headers: { 'Ocp-Apim-Subscription-Key': key } }).catch(() => {});
}

function parseBatchTranscript(result) {
  const phrases = result.recognizedPhrases || [];
  if (!phrases.length) throw new Error('Azure returned no recognized phrases');

  const speakerMap = {};
  let speakerCount = 0;

  return phrases.map(phrase => {
    const speakerId = phrase.speaker ?? 'Unknown';
    const text = phrase.nBest?.[0]?.display ?? '';
    if (!text.trim()) return null;

    if (speakerId === 'Unknown') return `Unknown: ${text.trim()}`;
    if (!speakerMap[speakerId]) {
      speakerCount++;
      speakerMap[speakerId] = `Speaker ${speakerCount}`;
    }
    return `${speakerMap[speakerId]}: ${text.trim()}`;
  }).filter(Boolean).join('\n');
}

async function batchDiarize(videoId) {
  const tmpId   = crypto.randomBytes(8).toString('hex');
  const tmpPath = path.join(os.tmpdir(), `yt_batch_${tmpId}`);
  let blobClient = null;
  let jobUrl     = null;

  try {
    await downloadAudio(videoId, tmpPath);

    const audioPath = `${tmpPath}.mp3`;
    if (!fs.existsSync(audioPath)) throw new Error('yt-dlp did not produce an mp3 output file');

    const blobName = `${tmpId}.mp3`;
    const { sasUrl, blobClient: bc } = await uploadBlob(audioPath, blobName);
    blobClient = bc;
    fs.unlink(audioPath, () => {});

    jobUrl = await submitBatchJob(sasUrl);

    const result = await pollBatchJob(jobUrl);

    blobClient.delete().catch(() => {});
    blobClient = null;

    return parseBatchTranscript(result);
  } finally {
    if (blobClient) blobClient.delete().catch(() => {});
    if (jobUrl) deleteBatchJob(jobUrl);
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
    if (!process.env.AZURE_STORAGE_CONNECTION_STRING || !process.env.AZURE_STORAGE_CONTAINER) {
      return res.status(500).json({ error: 'Azure Storage credentials not configured.' });
    }

    try {
      const transcript = await batchDiarize(videoId);
      return res.json({ transcript, videoId, language: 'en-US', mode: 'batch' });
    } catch (err) {
      return res.status(502).json({ error: err.message || 'Batch diarization failed.' });
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
