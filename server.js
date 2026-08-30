'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { ZipWriter } = require('./lib/zip');
const { extractImages, extractTitle, guessNameFromUrl, UA } = require('./lib/scraper');
const { politeFetch } = require('./lib/net');

const PORT = Number(process.env.PORT) || 3025;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_HTML_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 80 * 1024 * 1024;
const FETCH_TIMEOUT = 20000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/tiff': '.tiff',
  'image/heic': '.heic',
};

// ---------------------------------------------------------------- utilitas

function sanitizeFilename(name, fallback = 'gambar') {
  let out = String(name || '')
    .split(/[?#]/)[0]
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (!out) out = fallback;
  if (out.length > 120) {
    const dot = out.lastIndexOf('.');
    const ext = dot > 0 && out.length - dot <= 6 ? out.slice(dot) : '';
    out = out.slice(0, 120 - ext.length) + ext;
  }
  return out;
}

function ensureExtension(name, contentType) {
  if (/\.[a-z0-9]{2,5}$/i.test(name)) return name;
  const ext = EXT_BY_MIME[String(contentType || '').split(';')[0].trim().toLowerCase()] || '.jpg';
  return name + ext;
}

function normalizeFormat(value) {
  let f = String(value || '').toLowerCase();
  if (f === 'jpeg' || f === 'jfif') return 'jpg';
  if (f === 'svg+xml') return 'svg';
  if (f === 'x-icon' || f === 'vnd.microsoft.icon') return 'ico';
  return f;
}

function formatFromUrl(url) {
  if (url.startsWith('data:')) {
    const m = /^data:image\/([a-z0-9+.-]+)/i.exec(url);
    return m ? normalizeFormat(m[1]) : 'lainnya';
  }
  try {
    const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname);
    return m ? normalizeFormat(m[1]) : 'lainnya';
  } catch {
    return 'lainnya';
  }
}

function formatFromContentType(contentType, fallbackUrl) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (ct.startsWith('image/')) return normalizeFormat(ct.slice(6));
  return formatFromUrl(fallbackUrl);
}

function normalizeInputUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Alamat web belum diisi.');
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const u = new URL(withProto);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Hanya alamat http/https yang didukung.');
  return u.href;
}

// Header ditiru semirip mungkin dengan navigasi Chrome asli. Sebagian WAF
// menolak (403) permintaan yang cuma membawa User-Agent tanpa header Sec-*.
function browserHeaders(referer, kind = 'document') {
  const h = {
    'User-Agent': UA,
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate',
    'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not;A=Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };

  if (kind === 'image') {
    h.Accept = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
    h['Sec-Fetch-Dest'] = 'image';
    h['Sec-Fetch-Mode'] = 'no-cors';
    h['Sec-Fetch-Site'] = referer ? 'same-site' : 'none';
  } else {
    h.Accept =
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
    h['Upgrade-Insecure-Requests'] = '1';
    h['Sec-Fetch-Dest'] = 'document';
    h['Sec-Fetch-Mode'] = 'navigate';
    h['Sec-Fetch-Site'] = referer ? 'same-origin' : 'none';
    h['Sec-Fetch-User'] = '?1';
  }

  if (referer) {
    h.Referer = referer;
    // Origin hanya relevan untuk permintaan sub-resource, bukan navigasi.
    if (kind === 'image') {
      try {
        h.Origin = new URL(referer).origin;
      } catch {
        /* abaikan referer tak valid */
      }
    }
  }
  return h;
}

// Profil cadangan: sebagian server justru menolak header Sec-* / client hints.
function minimalHeaders(referer) {
  const h = {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
  };
  if (referer) h.Referer = referer;
  return h;
}

function isChallenged(resp) {
  return Boolean(
    resp.headers.get('cf-mitigated') ||
      /cloudflare|sucuri|incapsula|akamai/i.test(resp.headers.get('server') || '') ||
      resp.headers.get('x-sucuri-id') ||
      resp.headers.get('x-iinfo')
  );
}

function fetchWithTimeout(url, options = {}, ms = FETCH_TIMEOUT, retries = 2) {
  return politeFetch(url, options, { timeout: ms, retries });
}

function dataUriToBuffer(uri) {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(uri);
  if (!m) throw new Error('data URI tidak valid');
  const contentType = m[1] || 'application/octet-stream';
  const buf = m[2]
    ? Buffer.from(m[3], 'base64')
    : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  return { buf, contentType };
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Data permintaan terlalu besar.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { error: err.message };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

// ------------------------------------------------------------- /api/scan

async function handleScan(req, res) {
  const body = JSON.parse((await readBody(req, MAX_HTML_BYTES + 1024 * 1024)) || '{}');
  const deep = Boolean(body.deep);
  const pastedHtml = typeof body.html === 'string' ? body.html.trim() : '';

  let html;
  let finalUrl;

  if (pastedHtml) {
    // Mode tempel: HTML disalin pengguna dari browsernya sendiri. Berguna untuk
    // situs berproteksi anti-bot maupun halaman yang isinya dirender JavaScript.
    if (!String(body.url || '').trim()) {
      throw Object.assign(
        new Error('Isi juga alamat halamannya supaya URL gambar yang relatif bisa diselesaikan.'),
        { status: 400 }
      );
    }
    if (pastedHtml.length > MAX_HTML_BYTES) throw new Error('HTML yang ditempel terlalu besar.');
    finalUrl = normalizeInputUrl(body.url);
    html = pastedHtml;
  } else {
    const pageUrl = normalizeInputUrl(body.url);
    let resp = await fetchWithTimeout(pageUrl, { headers: browserHeaders(null, 'document') });

    // Sebagian WAF menolak profil header kita; coba sekali lagi dengan header polos.
    if (resp.status === 403 || resp.status === 401 || resp.status === 406) {
      const retry = await fetchWithTimeout(pageUrl, { headers: minimalHeaders() }, FETCH_TIMEOUT, 0);
      if (retry.ok) resp = retry;
      else if (!isChallenged(retry)) resp = retry;
    }

    if (!resp.ok) {
      const challenged = resp.status === 403 && isChallenged(resp);
      const message = challenged
        ? 'Situs ini memakai proteksi anti-bot (Cloudflare dsb.) yang menuntut verifikasi lewat browser, ' +
          'jadi halamannya tidak bisa diambil langsung. Gunakan mode "Tempel HTML halaman": buka halaman itu ' +
          'di browser, salin kode sumbernya, lalu tempel di sini.'
        : `Server tujuan menolak (HTTP ${resp.status} ${resp.statusText}). ` +
          'Coba mode "Tempel HTML halaman" bila halaman itu tetap bisa dibuka di browser.';
      throw Object.assign(new Error(message), { status: 502, code: challenged ? 'challenge' : 'blocked' });
    }

    const contentType = resp.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml|text\/plain|application\/xml/i.test(contentType)) {
      throw Object.assign(
        new Error(`Alamat itu bukan halaman web (${contentType || 'tipe tak dikenal'}).`),
        { status: 415 }
      );
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_HTML_BYTES) throw new Error('Halaman terlalu besar untuk dipindai.');
    const charset = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase();
    try {
      html = new TextDecoder(charset && charset !== 'utf8' ? charset : 'utf-8').decode(buf);
    } catch {
      html = buf.toString('utf8');
    }
    finalUrl = resp.url || pageUrl;
  }
  const { images } = extractImages(html, finalUrl, { deep });

  // Metadata (ukuran & tipe) diambil terpisah lewat /api/meta supaya daftar
  // gambar langsung tampil, tidak menunggu ratusan permintaan HEAD selesai.
  const out = images.map((img, i) => ({
    id: `g${i}`,
    url: img.url,
    name: sanitizeFilename(img.name || guessNameFromUrl(img.url)),
    alt: img.alt,
    source: img.source,
    contentType: '',
    format: formatFromUrl(img.url),
    size: img.url.startsWith('data:') ? dataUriToBuffer(img.url).buf.length : null,
    attrWidth: img.attrWidth,
    attrHeight: img.attrHeight,
  }));

  sendJson(res, 200, {
    pageUrl: finalUrl,
    title: extractTitle(html),
    count: out.length,
    fromPaste: Boolean(pastedHtml),
    images: out,
  });
}

// ------------------------------------------------------------- /api/meta

// Ambil tipe & ukuran berkas untuk sekumpulan URL (dipanggil bertahap oleh klien).
async function handleMeta(req, res) {
  const body = JSON.parse((await readBody(req)) || '{}');
  const items = Array.isArray(body.items) ? body.items.slice(0, 60) : [];
  const referer = body.referer || '';

  const out = await mapLimit(items, 8, async (item) => {
    const url = item.url;
    if (String(url).startsWith('data:')) {
      const { buf, contentType } = dataUriToBuffer(url);
      return { id: item.id, size: buf.length, contentType, format: normalizeFormat(contentType.replace('image/', '')), ok: true };
    }
    const headers = browserHeaders(referer, 'image');
    let contentType = '';
    let size = null;
    let ok = false;
    try {
      const r = await fetchWithTimeout(url, { method: 'HEAD', headers }, 12000, 1);
      if (r.ok) {
        ok = true;
        contentType = r.headers.get('content-type') || '';
        size = Number(r.headers.get('content-length'));
      }
    } catch {
      /* lanjut ke fallback */
    }
    if (!ok) {
      try {
        const r = await fetchWithTimeout(
          url,
          { method: 'GET', headers: { ...headers, Range: 'bytes=0-0' } },
          12000,
          0
        );
        ok = r.ok || r.status === 206;
        contentType = r.headers.get('content-type') || '';
        const range = r.headers.get('content-range');
        size = range ? Number(range.split('/')[1]) : Number(r.headers.get('content-length'));
        try {
          r.body?.cancel();
        } catch {
          /* abaikan */
        }
      } catch {
        /* biarkan tak diketahui */
      }
    }
    return {
      id: item.id,
      ok,
      contentType: contentType.split(';')[0].trim().toLowerCase(),
      format: formatFromContentType(contentType, url),
      size: Number.isFinite(size) && size > 0 ? size : null,
    };
  });

  sendJson(res, 200, { results: out });
}

// -------------------------------------------------------------- /api/img

async function handleImage(req, res, url) {
  const target = url.searchParams.get('u');
  if (!target) throw Object.assign(new Error('Parameter u wajib diisi.'), { status: 400 });
  const referer = url.searchParams.get('r') || '';
  const download = url.searchParams.get('dl') === '1';
  const name = url.searchParams.get('n') || '';

  if (target.startsWith('data:')) {
    const { buf, contentType } = dataUriToBuffer(target);
    const headers = { 'Content-Type': contentType, 'Content-Length': buf.length };
    if (download) {
      headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(
        ensureExtension(sanitizeFilename(name), contentType)
      )}`;
    }
    res.writeHead(200, headers);
    res.end(buf);
    return;
  }

  const upstream = await fetchWithTimeout(target, { headers: browserHeaders(referer, 'image') }, 30000);
  if (!upstream.ok || !upstream.body) {
    const msg =
      upstream.status === 429
        ? 'Situs sumber sedang membatasi laju permintaan (429). Tunggu sebentar lalu coba lagi.'
        : `Gagal mengambil gambar (HTTP ${upstream.status}).`;
    throw Object.assign(new Error(msg), { status: 502 });
  }
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'private, max-age=600',
  };
  const len = upstream.headers.get('content-length');
  if (len) headers['Content-Length'] = len;
  if (download) {
    const finalName = ensureExtension(
      sanitizeFilename(name || guessNameFromUrl(target)),
      contentType
    );
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(finalName)}`;
  }
  res.writeHead(200, headers);
  await pipeline(Readable.fromWeb(upstream.body), res);
}

// -------------------------------------------------------------- /api/zip

async function handleZip(req, res) {
  const raw = req.method === 'POST' ? await readBody(req) : '';
  let payload;
  if (req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
    payload = JSON.parse(new URLSearchParams(raw).get('payload') || '{}');
  } else {
    payload = JSON.parse(raw || '{}');
  }

  const items = Array.isArray(payload.items) ? payload.items.slice(0, 1000) : [];
  if (!items.length) throw Object.assign(new Error('Tidak ada gambar yang dipilih.'), { status: 400 });
  const referer = payload.referer || '';
  const zipName = sanitizeFilename(payload.zipName || 'gambar', 'gambar').replace(/\.zip$/i, '') + '.zip';

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`,
    'Cache-Control': 'no-store',
  });

  const zip = new ZipWriter(res);
  const report = [];
  let ok = 0;
  let failed = 0;

  // Unduh paralel (batch) tapi tulis ke ZIP secara berurutan.
  const BATCH = 6;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const fetched = await Promise.all(
      batch.map(async (item) => {
        try {
          if (String(item.url).startsWith('data:')) {
            const { buf, contentType } = dataUriToBuffer(item.url);
            return { item, buf, contentType };
          }
          const r = await fetchWithTimeout(item.url, { headers: browserHeaders(referer, 'image') }, 30000);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const ab = await r.arrayBuffer();
          if (ab.byteLength > MAX_IMAGE_BYTES) throw new Error('berkas terlalu besar');
          return {
            item,
            buf: Buffer.from(ab),
            contentType: r.headers.get('content-type') || '',
          };
        } catch (err) {
          return { item, error: err.message };
        }
      })
    );

    for (const f of fetched) {
      if (f.error || !f.buf?.length) {
        failed += 1;
        report.push(`GAGAL  ${f.item.url}  -> ${f.error || 'kosong'}`);
        continue;
      }
      const name = ensureExtension(
        sanitizeFilename(f.item.name || guessNameFromUrl(f.item.url)),
        f.contentType
      );
      await zip.add(name, f.buf);
      ok += 1;
    }
  }

  const summary =
    `Diambil dari : ${referer || '-'}\n` +
    `Waktu        : ${new Date().toLocaleString('id-ID')}\n` +
    `Berhasil     : ${ok}\n` +
    `Gagal        : ${failed}\n` +
    (report.length ? `\n--- Rincian kegagalan ---\n${report.join('\n')}\n` : '');
  await zip.add('_daftar-unduhan.txt', Buffer.from(summary, 'utf8'));

  await zip.finish();
  res.end();
}

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
    if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true });
    return await serveStatic(req, res, url);
  } catch (err) {
    const status = err.status || (err.name === 'AbortError' ? 504 : 500);
    const code = err.cause?.code || '';
    let message = err.message || 'Terjadi kesalahan.';
    if (err.name === 'AbortError') {
      message = 'Waktu tunggu habis saat menghubungi situs tujuan.';
    } else if (message === 'fetch failed') {
      message =
        code === 'ENOTFOUND'
          ? 'Alamat tidak ditemukan. Periksa lagi ejaan domainnya.'
          : code === 'ECONNREFUSED'
            ? 'Koneksi ditolak oleh server tujuan.'
            : `Gagal terhubung ke situs tujuan${code ? ` (${code})` : ''}. Periksa koneksi internet.`;
    }
    console.error(`[error] ${req.method} ${url.pathname}:`, message);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (url.pathname.startsWith('/api/')) sendJson(res, status, { error: message, code: err.code || '' });
    else res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(message);
  }
});

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
