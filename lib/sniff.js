'use strict';

// Mengenali gambar dari isinya, bukan dari kata-kata server. Sebagian server
// mengirim gambar dengan Content-Type `application/octet-stream`, dan yang
// lebih berbahaya: server yang butuh login membalas HTTP 200 berisi halaman
// login. Tanpa pemeriksaan ini, halaman itu ikut tersimpan sebagai berkas
// ".jpg" yang tentu saja tidak bisa dibuka.

const TANDA = [
  { tipe: 'image/jpeg', cocok: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    tipe: 'image/png',
    cocok: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  { tipe: 'image/gif', cocok: (b) => b.slice(0, 3).toString('latin1') === 'GIF' },
  {
    tipe: 'image/webp',
    cocok: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP',
  },
  { tipe: 'image/bmp', cocok: (b) => b[0] === 0x42 && b[1] === 0x4d },
  { tipe: 'image/x-icon', cocok: (b) => b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0 },
  {
    tipe: 'image/tiff',
    cocok: (b) =>
      (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a),
  },
  {
    // Kotak ISO-BMFF: AVIF, HEIC, dan kerabatnya.
    tipe: 'image/avif',
    cocok: (b) => b.slice(4, 8).toString('latin1') === 'ftyp' && /avif|heic|heix|mif1/i.test(b.slice(8, 16).toString('latin1')),
  },
];

/**
 * @param {Buffer} buf awal isi berkas (32 byte pertama sudah cukup)
 * @returns {string} tipe MIME bila dikenali, atau '' bila bukan gambar
 */
function sniffImageType(buf) {
  if (!buf || buf.length < 4) return '';
  for (const t of TANDA) {
    try {
      if (t.cocok(buf)) return t.tipe;
    } catch {
      /* buffer terlalu pendek untuk tanda ini */
    }
  }
  // SVG berupa teks, jadi diperiksa terpisah.
  const awal = buf.slice(0, 400).toString('utf8').trimStart().toLowerCase();
  if (awal.startsWith('<svg') || (awal.startsWith('<?xml') && awal.includes('<svg'))) {
    return 'image/svg+xml';
  }
  return '';
}

/**
 * Menyusun pesan yang menjelaskan kenapa isi yang diterima bukan gambar.
 * @param {Buffer} buf awal isi
 * @param {string} contentType Content-Type dari server sumber
 */
function jelaskanBukanGambar(buf, contentType, urlAkhir = '') {
  const teks = buf.slice(0, 4000).toString('utf8').toLowerCase();
  const ct = String(contentType || '').split(';')[0].trim() || 'tanpa tipe';

  // Petunjuk terkuat: permintaan berakhir di halaman login (setelah redirect).
  if (/\/(login|signin|sign-in|masuk|auth)(\/|\?|$)/i.test(urlAkhir)) {
    return (
      'Permintaan berakhir di halaman login, bukan gambar. Gambar ini hanya bisa diambil ' +
      'oleh browser yang sudah login pada situs tersebut.'
    );
  }

  if (/type=["']password["']|\bsign in\b|\blog in\b|\blogin\b|\bmasuk\b|kata sandi/.test(teks)) {
    return (
      'Server sumber membalas halaman login, bukan gambar. Gambar ini hanya bisa diambil ' +
      'oleh browser yang sudah login — unduh langsung dari tab tempat Anda membuka halamannya.'
    );
  }
  if (/access denied|forbidden|not authorized|unauthorized|403/.test(teks)) {
    return 'Server sumber menolak akses ke gambar ini (kemungkinan proteksi hotlink atau perlu izin khusus).';
  }
  if (/<html|<!doctype/.test(teks)) {
    return `Server sumber mengirim halaman web (${ct}), bukan berkas gambar.`;
  }
  return `Isi yang diterima bukan gambar yang dikenali (${ct}).`;
}

module.exports = { sniffImageType, jelaskanBukanGambar };
