'use strict';

// Server lokal: menyajikan berkas statis di public/ dan meneruskan /api/*
// ke handler bersama di lib/handlers.js (yang juga dipakai function Vercel).

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const {
  handleScan,
  handleMeta,
  handleImage,
  handleZip,
  sendJson,
  describeError,
  MIME,
} = require('./lib/handlers');
const { isEnabled, isAuthorized, checkPassword, cookieHeader } = require('./lib/auth');

const PORT = Number(process.env.PORT) || 3025;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ------------------------------------------------------------ berkas statis

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Terlarang');
    return;
  }
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('bukan berkas');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    await pipeline(fs.createReadStream(filePath), res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 - tidak ditemukan');
  }
}

// ------------------------------------------------------------------ server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/scan' && req.method === 'POST') return await handleScan(req, res);
    if (url.pathname === '/api/meta' && req.method === 'POST') return await handleMeta(req, res);
    if (url.pathname === '/api/img' && req.method === 'GET') return await handleImage(req, res, url);
    if (url.pathname === '/api/zip' && req.method === 'POST') return await handleZip(req, res);
    if (url.pathname === '/api/login' && req.method === 'POST') return await handleLogin(req, res);
    if (url.pathname === '/api/session')
      return sendJson(res, 200, { locked: isEnabled(), authorized: isAuthorized(req) });
    if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true });
    return await serveStatic(req, res, url);
  } catch (err) {
    const { status, message, code } = describeError(err);
    console.error(`[error] ${req.method} ${url.pathname}:`, message);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (url.pathname.startsWith('/api/')) sendJson(res, status, { error: message, code });
    else res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(message);
  }
});

// Login hanya berarti bila IG_PASSWORD diisi (dipakai saat di-deploy ke Vercel).
async function handleLogin(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    /* biarkan kosong */
  }
  if (!isEnabled()) return sendJson(res, 200, { ok: true, locked: false });
  if (!checkPassword(body.password)) {
    return sendJson(res, 401, { error: 'Kata sandi salah.', code: 'auth' });
  }
  res.setHeader('Set-Cookie', cookieHeader(false));
  sendJson(res, 200, { ok: true });
}

// Node 18 ke bawah tidak punya fetch global — hentikan dengan pesan yang jelas
// alih-alih meledak dengan "fetch is not defined" di tengah pemindaian.
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 18) {
  console.error(
    `\n  [GAGAL] Node.js versi ${process.versions.node} terlalu lama.\n` +
      '  Aplikasi ini butuh Node.js 18 atau lebih baru (unduh yang LTS di https://nodejs.org).\n'
  );
  process.exit(1);
}

// Default hanya bisa diakses dari komputer ini. Untuk membukanya ke jaringan
// lokal (mis. dibuka dari HP), jalankan dengan HOST=0.0.0.0 — sadari risikonya.
const HOST = process.env.HOST || '127.0.0.1';
const MAX_PORT_TRIES = 10;

function start(port, attempt = 0) {
  // Callback bawaan listen() tetap tersimpan bila percobaan gagal, lalu ikut
  // terpanggil saat percobaan berikutnya berhasil (mencetak port yang salah).
  // Karena itu 'listening' dan 'error' dipasang & dilepas manual.
  const onListening = () => {
    server.removeListener('error', onError);
    announce(server.address().port);
  };

  const onError = (err) => {
    server.removeListener('listening', onListening);
    if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_TRIES) {
      console.log(`  Port ${port} sedang dipakai, mencoba ${port + 1}…`);
      start(port + 1, attempt + 1);
      return;
    }
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  [GAGAL] Port ${PORT}-${port} semuanya terpakai.`);
      console.error('  Tutup aplikasi lain yang memakai port itu, atau jalankan: set PORT=8080 & node server.js\n');
    } else if (err.code === 'EACCES') {
      console.error(`\n  [GAGAL] Tidak diizinkan memakai port ${port}. Coba port di atas 1024.\n`);
    } else {
      console.error(`\n  [GAGAL] Server tidak bisa dinyalakan: ${err.message}\n`);
    }
    process.exit(1);
  };

  server.once('listening', onListening);
  server.once('error', onError);
  server.listen(port, HOST);
}

function announce(port) {
  const url = `http://localhost:${port}`;
  console.log(`\n  Image Grabber siap  ->  ${url}\n`);
  if (HOST === '0.0.0.0') console.log('  (terbuka untuk jaringan lokal)\n');

  // Dijalankan lewat jalankan.cmd → bukakan browser sekalian.
  if (process.env.IG_OPEN === '1') {
    const { spawn } = require('node:child_process');
    try {
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch {
      console.log(`  Buka sendiri di browser: ${url}\n`);
    }
  }
}

start(PORT);
