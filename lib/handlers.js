'use strict';

// Seluruh logika API dipakai bersama oleh dua bentuk penyajian:
//   - server lokal (server.js) yang berjalan terus-menerus, dan
//   - serverless function Vercel (api/*.js) yang hidup sekali per permintaan.
// Karena keduanya memakai (req, res) bergaya Node, handler di bawah bisa
// dipanggil apa adanya oleh keduanya.

const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { ZipWriter } = require('./zip');
const { extractImages, extractTitle, guessNameFromUrl, UA } = require('./scraper');
const { politeFetch } = require('./net');
const { assertAuth } = require('./auth');

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

// Vercel sudah mem-parse body sebelum handler dipanggil (dan stream-nya ikut
// terkonsumsi), sedangkan server lokal menyerahkan stream mentah. Fungsi ini
// menerima keduanya sehingga handler tidak perlu tahu sedang berjalan di mana.
async function readPayload(req, limit) {
  const parsed = req.body;
  if (parsed !== undefined && parsed !== null && !Buffer.isBuffer(parsed)) {
    if (typeof parsed === 'object') return parsed;
    if (typeof parsed === 'string' && parsed) {
      try {
        return JSON.parse(parsed);
      } catch {
        return Object.fromEntries(new URLSearchParams(parsed));
      }
    }
  }
  const raw = Buffer.isBuffer(parsed) ? parsed.toString('utf8') : await readBody(req, limit);
  if (!raw) return {};
  const isForm = String(req.headers['content-type'] || '').includes('x-www-form-urlencoded');
  if (isForm) return Object.fromEntries(new URLSearchParams(raw));
  return JSON.parse(raw);
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

// Mengenali dua sebab tersering hasil pindai "cuma ikon": halaman ternyata
// meminta login, atau isinya baru dirender JavaScript di browser. Tanpa ini,
// aplikasi diam-diam menampilkan hasil dari halaman yang salah.
function deteksiHambatan(diminta, finalUrl, html, gambar, placeholders = 0) {
  const alasan = [];
  const jumlahGambar = gambar.length;

  const POLA_LOGIN = /(^|\/)(login|signin|sign-in|masuk|auth|session)(\/|$)/i;
  let dialihkan = false;
  try {
    const a = new URL(diminta);
    const b = new URL(finalUrl);
    dialihkan = a.pathname.replace(/\/$/, '') !== b.pathname.replace(/\/$/, '');
    if (dialihkan && POLA_LOGIN.test(b.pathname)) {
      alasan.push(
        `Halaman ini meminta login — permintaan dialihkan ke ${b.pathname}. ` +
          'Yang terpindai adalah halaman login, bukan halaman yang Anda maksud.'
      );
    } else if (dialihkan) {
      alasan.push(`Alamat dialihkan ke ${b.pathname} — isinya mungkin bukan halaman yang Anda tuju.`);
    }
  } catch {
    /* abaikan URL tak terbaca */
  }

  const banyakSkrip = (html.match(/<script\b/gi) || []).length >= 5;

  // Kerangka SPA: wadah kosong + banyak script, tapi nyaris tanpa <img>.
  const wadahKosong = /<div[^>]+id=["'](root|app|content|__next|main)["'][^>]*>\s*<\/div>/i.test(html);
  const kerangkaKosong = wadahKosong && banyakSkrip && jumlahGambar < 8;

  // Kasus yang lebih halus: halaman penuh gambar, tapi SEMUANYA aset bawaan
  // situs (logo, ikon, sprite) — pertanda isi aslinya diambil lewat API
  // setelah halaman terbuka, seperti daftar produk atau galeri.
  const ASET_SITUS = /\/(assets?|static|dist|build|theme|templates?|images?\/(ui|icons?))\//i;
  const NAMA_HIASAN = /(logo|icon|sprite|favicon|placeholder|banner|avatar|flag|badge)/i;
  const isiNyata = gambar.filter((g) => {
    if (!['img', 'picture', 'tautan', 'dalam'].includes(g.source)) return false;
    if (g.url.startsWith('data:')) return false;
    return !ASET_SITUS.test(g.url) && !NAMA_HIASAN.test(g.name || g.url);
  }).length;

  if (placeholders > 0) {
    alasan.push(
      `Ditemukan ${placeholders} tag gambar yang alamatnya masih berupa placeholder template ` +
        '(mis. `${...}`) — bukti bahwa foto-fotonya baru diisi JavaScript setelah halaman terbuka, ' +
        'jadi belum ada di HTML awal.'
    );
  } else if (kerangkaKosong) {
    alasan.push(
      'Isi halaman ini dirender JavaScript di browser, jadi HTML awalnya masih kosong. ' +
        'Melihat sumber halaman (Ctrl+U) pun tidak akan memuat gambarnya.'
    );
  } else if (isiNyata === 0 && banyakSkrip && !dialihkan) {
    alasan.push(
      `Semua ${jumlahGambar} gambar yang terbaca hanyalah aset bawaan situs (logo, ikon). ` +
        'Gambar isinya kemungkinan besar baru dimuat lewat JavaScript setelah halaman terbuka, ' +
        'sehingga belum ada di HTML awal.'
    );
  }

  if (!alasan.length) return '';
  return (
    alasan.join(' ') +
    ' Pakai mode "Tempel HTML halaman": buka halaman itu di browser (sudah login), ' +
    'tekan F12 → Console, jalankan copy(document.documentElement.outerHTML), lalu tempel di sini.'
  );
}

// ------------------------------------------------------------- /api/scan

async function handleScan(req, res) {
  assertAuth(req);
  const body = await readPayload(req, MAX_HTML_BYTES + 1024 * 1024);
  const deep = Boolean(body.deep);
  const pastedHtml = typeof body.html === 'string' ? body.html.trim() : '';

  let html;
  let finalUrl;
  let diminta = '';

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
    diminta = pageUrl;
  }
  const { images, placeholders } = extractImages(html, finalUrl, { deep });

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

  const catatan = pastedHtml ? '' : deteksiHambatan(diminta, finalUrl, html, out, placeholders);

  sendJson(res, 200, {
    pageUrl: finalUrl,
    title: extractTitle(html),
    count: out.length,
    fromPaste: Boolean(pastedHtml),
    notice: catatan,
    images: out,
  });
}

// ------------------------------------------------------------- /api/meta

// Ambil tipe & ukuran berkas untuk sekumpulan URL (dipanggil bertahap oleh klien).
async function handleMeta(req, res) {
  assertAuth(req);
  const body = await readPayload(req);
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
  assertAuth(req);
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
  assertAuth(req);
  // Dari UI, ZIP diminta lewat <form> (field "payload"); dari skrip/curl bisa
  // langsung JSON. readPayload menyamakan keduanya, lokal maupun di Vercel.
  const body = await readPayload(req);
  const payload = typeof body.payload === 'string' ? JSON.parse(body.payload) : body;

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

  // Di serverless (Vercel) function dipaksa berhenti setelah maxDuration, dan
  // ZIP yang terpotong di tengah tidak bisa dibuka sama sekali. Karena itu
  // pengambilan dihentikan lebih awal lalu ZIP ditutup rapi — pengguna dapat
  // berkas yang tetap valid berisi gambar yang sempat terunduh.
  const anggaranWaktu = Number(process.env.IG_ZIP_BUDGET_MS) || (process.env.VERCEL ? 45000 : 0);
  const mulai = Date.now();
  let terpotong = 0;

  // Unduh paralel (batch) tapi tulis ke ZIP secara berurutan.
  const BATCH = 6;
  for (let i = 0; i < items.length; i += BATCH) {
    if (anggaranWaktu && Date.now() - mulai > anggaranWaktu) {
      terpotong = items.length - i;
      break;
    }
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
    (terpotong
      ? `\nCATATAN: ${terpotong} gambar TIDAK ikut diunduh karena batas waktu server\n` +
        'tercapai. ZIP ini tetap utuh dan bisa dibuka. Untuk mengambil sisanya,\n' +
        'pilih gambar yang belum terunduh lalu unduh lagi — atau jalankan aplikasi\n' +
        'ini di komputer sendiri (tanpa batas waktu).\n'
      : '') +
    (report.length ? `\n--- Rincian kegagalan ---\n${report.join('\n')}\n` : '');
  await zip.add('_daftar-unduhan.txt', Buffer.from(summary, 'utf8'));

  await zip.finish();
  res.end();
}

// ------------------------------------------------------- pelaporan kesalahan

// Mengubah exception apa pun menjadi status + pesan berbahasa Indonesia.
function describeError(err) {
  const status = err.status || (err.name === 'AbortError' ? 504 : 500);
  const cause = err.cause?.code || '';
  let message = err.message || 'Terjadi kesalahan.';
  if (err.name === 'AbortError') {
    message = 'Waktu tunggu habis saat menghubungi situs tujuan.';
  } else if (message === 'fetch failed') {
    message =
      cause === 'ENOTFOUND'
        ? 'Alamat tidak ditemukan. Periksa lagi ejaan domainnya.'
        : cause === 'ECONNREFUSED'
          ? 'Koneksi ditolak oleh server tujuan.'
          : `Gagal terhubung ke situs tujuan${cause ? ` (${cause})` : ''}. Periksa koneksi internet.`;
  }
  return { status, message, code: err.code || '' };
}

module.exports = {
  handleScan,
  handleMeta,
  handleImage,
  handleZip,
  sendJson,
  describeError,
  MIME,
};
