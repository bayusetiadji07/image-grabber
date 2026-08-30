'use strict';

const $ = (sel) => document.querySelector(sel);

const el = {
  form: $('#scan-form'),
  url: $('#url'),
  deep: $('#deep'),
  btnScan: $('#btn-scan'),
  riwayat: $('#riwayat'),
  pageInfo: $('#page-info'),
  errorBox: $('#error-box'),
  noticeBox: $('#notice-box'),
  results: $('#results'),
  placeholder: $('#placeholder'),
  stats: $('#stats'),
  grid: $('#grid'),
  empty: $('#empty'),
  fSearch: $('#f-search'),
  fFormat: $('#f-format'),
  fMinW: $('#f-minw'),
  fMinKb: $('#f-minkb'),
  fSort: $('#f-sort'),
  fHideTiny: $('#f-hide-tiny'),
  btnZip: $('#btn-zip'),
  zipLabel: $('#zip-label'),
  zipForm: $('#zip-form'),
  zipPayload: $('#zip-payload'),
  lightbox: $('#lightbox'),
  lbImg: $('#lb-img'),
  lbInfo: $('#lb-info'),
  lbDl: $('#lb-dl'),
  lbClose: $('#lb-close'),
  toast: $('#toast'),
  pastePanel: $('#paste-panel'),
  pasteHtml: $('#paste-html'),
  pasteCount: $('#paste-count'),
  btnScanPaste: $('#btn-scan-paste'),
  btnClearPaste: $('#btn-clear-paste'),
  gate: $('#gate'),
  gateForm: $('#gate-form'),
  gatePassword: $('#gate-password'),
  gateSubmit: $('#gate-submit'),
  gateError: $('#gate-error'),
};

const state = {
  pageUrl: '',
  title: '',
  images: [],
  visible: [],
  metaTotal: 0,
  metaDone: 0,
};

// Unduhan ZIP dikirim ke iframe tersembunyi agar tidak membuka tab kosong.
const sink = document.createElement('iframe');
sink.name = 'zip-sink';
sink.hidden = true;
sink.style.display = 'none';
document.body.appendChild(sink);
el.zipForm.target = 'zip-sink';

// ------------------------------------------------------------- utilitas

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

function proxyUrl(imgUrl, { download = false, name = '' } = {}) {
  const p = new URLSearchParams({ u: imgUrl });
  if (state.pageUrl) p.set('r', state.pageUrl);
  if (download) {
    p.set('dl', '1');
    if (name) p.set('n', name);
  }
  return `/api/img?${p.toString()}`;
}

let toastTimer;
function toast(message, kind = '') {
  el.toast.textContent = message;
  el.toast.className = `toast ${kind}`;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 3200);
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem('ig-riwayat') || '[]');
  } catch {
    return [];
  }
}

function saveHistory(url) {
  const list = [url, ...loadHistory().filter((u) => u !== url)].slice(0, 15);
  try {
    localStorage.setItem('ig-riwayat', JSON.stringify(list));
  } catch {
    /* penyimpanan penuh / diblokir — abaikan */
  }
  renderHistory(list);
}

function renderHistory(list = loadHistory()) {
  el.riwayat.innerHTML = list.map((u) => `<option value="${u}"></option>`).join('');
}

// ------------------------------------------------------------- pemindaian

async function scan(event, html = '') {
  if (event) event.preventDefault();
  const url = el.url.value.trim();
  if (!url) {
    el.url.focus();
    return;
  }

  setLoading(true, Boolean(html));
  el.errorBox.hidden = true;
  el.noticeBox.hidden = true;
  el.pastePanel.classList.remove('highlight');

  try {
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, deep: el.deep.checked, html }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw Object.assign(new Error(data.error || `Gagal memindai (HTTP ${res.status}).`), {
        code: data.code || '',
      });
    }

    metaQueue = [];
    state.metaTotal = 0;
    state.metaDone = 0;
    state.pageUrl = data.pageUrl;
    state.title = data.title;
    state.images = data.images.map((img) => ({ ...img, selected: false, w: null, h: null }));

    saveHistory(url);
    el.pageInfo.hidden = false;
    el.pageInfo.innerHTML =
      `Sumber: <strong>${escapeHtml(data.title || '(tanpa judul)')}</strong> — ${escapeHtml(data.pageUrl)}` +
      (data.fromPaste ? ' <em>(dari HTML tempelan)</em>' : '');
    if (data.fromPaste) el.pastePanel.open = false;

    // Halaman minta login / dirender JavaScript → jelaskan dan buka mode tempel.
    el.noticeBox.hidden = !data.notice;
    if (data.notice) {
      el.noticeBox.innerHTML = escapeHtml(data.notice).replace(
        'copy(document.documentElement.outerHTML)',
        '<code>copy(document.documentElement.outerHTML)</code>'
      );
      el.pastePanel.open = true;
      el.pastePanel.classList.add('highlight');
    }

    if (!state.images.length) {
      el.results.hidden = true;
      el.placeholder.hidden = false;
      toast('Tidak ada gambar yang terdeteksi di halaman itu.', 'bad');
      return;
    }

    buildFormatOptions();
    el.placeholder.hidden = true;
    el.results.hidden = false;
    applyFilters();
    toast(`${state.images.length} gambar terdeteksi.`, 'ok');
  } catch (err) {
    // Sesi habis / belum masuk → minta kata sandi lagi.
    if (err.code === 'auth') {
      showGate(err.message);
      return;
    }
    el.errorBox.hidden = false;
    el.errorBox.textContent = err.message;
    // Situs memblokir pengambilan langsung → arahkan ke mode tempel HTML.
    if ((err.code === 'challenge' || err.code === 'blocked') && !html) {
      el.pastePanel.open = true;
      el.pastePanel.classList.add('highlight');
      el.pasteHtml.focus();
    }
    toast('Pemindaian gagal.', 'bad');
  } finally {
    setLoading(false);
  }
}

function setLoading(on, fromPaste = false) {
  el.btnScan.disabled = on;
  el.btnScanPaste.disabled = on;
  el.btnScan.querySelector('.btn-label').textContent = on && !fromPaste ? 'Memindai…' : 'Pindai Halaman';
  el.btnScan.querySelector('.spinner').hidden = !on || fromPaste;
  el.btnScanPaste.textContent = on && fromPaste ? 'Memindai…' : 'Pindai dari HTML';
}

function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function buildFormatOptions() {
  const counts = new Map();
  for (const img of state.images) counts.set(img.format, (counts.get(img.format) || 0) + 1);
  const opts = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  el.fFormat.innerHTML =
    `<option value="">Semua format (${state.images.length})</option>` +
    opts.map(([f, n]) => `<option value="${escapeHtml(f)}">${escapeHtml(f.toUpperCase())} (${n})</option>`).join('');
}

// ------------------------------------------------------------- filter

function applyFilters() {
  const q = el.fSearch.value.trim().toLowerCase();
  const format = el.fFormat.value;
  const minW = Number(el.fMinW.value) || 0;
  const minKb = Number(el.fMinKb.value) || 0;
  const hideTiny = el.fHideTiny.checked;

  let list = state.images.filter((img) => {
    if (q && !(`${img.name} ${img.url} ${img.alt}`.toLowerCase().includes(q))) return false;
    if (format && img.format !== format) return false;
    if (minW) {
      const w = img.w ?? img.attrWidth ?? 0;
      if (w && w < minW) return false;
      if (!w) return false;
    }
    if (minKb && (img.size ?? 0) < minKb * 1024) return false;
    if (hideTiny && img.size !== null && img.size < 5 * 1024) return false;
    return true;
  });

  const sort = el.fSort.value;
  if (sort === 'size') list = [...list].sort((a, b) => (b.size ?? -1) - (a.size ?? -1));
  else if (sort === 'dim')
    list = [...list].sort((a, b) => (b.w ?? 0) * (b.h ?? 0) - (a.w ?? 0) * (a.h ?? 0));
  else if (sort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name, 'id'));

  state.visible = list;
  renderGrid();
  renderStats();
}

// ------------------------------------------------------------- render

// Pratinjau dimuat berantre (maks. 4 sekaligus) supaya situs sumber tidak
// membalas 429 saat halaman punya ratusan gambar.
const thumbQueue = { pending: [], active: 0, max: 4 };

function enqueueThumb(imgEl, url) {
  thumbQueue.pending.push({ imgEl, url });
  pumpThumbs();
}

function pumpThumbs() {
  while (thumbQueue.active < thumbQueue.max && thumbQueue.pending.length) {
    const job = thumbQueue.pending.shift();
    if (!job.imgEl.isConnected) continue;
    thumbQueue.active += 1;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      thumbQueue.active -= 1;
      pumpThumbs();
    };
    job.imgEl.addEventListener('load', finish, { once: true });
    job.imgEl.addEventListener('error', finish, { once: true });
    job.imgEl.src = job.url;
  }
}

// Menanyakan ke server kenapa sebuah gambar gagal diambil, supaya kartu bisa
// menampilkan alasannya alih-alih "gagal" tanpa keterangan.
async function alasanGagal(url) {
  try {
    const res = await fetch(proxyUrl(url));
    if (res.ok) return '';
    const data = await res.json().catch(() => ({}));
    return data.error || `Gagal (HTTP ${res.status}).`;
  } catch {
    return 'Tidak bisa menghubungi server.';
  }
}

// Pasang (atau pasang ulang) elemen pratinjau pada sebuah kartu.
function mountThumb(card, img) {
  const box = card.querySelector('.thumb');
  box.style.cursor = 'zoom-in';
  const thumbImg = document.createElement('img');
  thumbImg.alt = img.alt || img.name;
  box.replaceChildren(thumbImg);

  thumbImg.addEventListener('load', () => {
    img.broken = false;
    img.w = thumbImg.naturalWidth;
    img.h = thumbImg.naturalHeight;
    const dimEl = card.querySelector('.dim');
    if (dimEl) dimEl.textContent = `${img.w}×${img.h}`;
  });

  thumbImg.addEventListener('error', async () => {
    img.broken = true;
    box.style.cursor = 'default';

    // Kemungkinan gambar butuh sesi login. Tab asal masih terbuka dan masih
    // login — minta dia yang mengambilkannya.
    let pesanTabAsal = '';
    if (!img.blobUrl && bisaMintaKeTabAsal() && tabAsalVersi >= 2) {
      box.innerHTML = '<span class="fail">Mencoba lewat tab asal…</span>';
      try {
        const blob = await mintaGambarKeTabAsal(img.url);
        if (blob && blob.size) {
          img.blob = blob;
          img.blobUrl = URL.createObjectURL(blob);
          img.size = blob.size;
          img.lewatTabAsal = true;
          patchCard(img);
          mountThumb(card, img);
          return;
        }
        pesanTabAsal = 'Tab asal mengembalikan berkas kosong.';
      } catch (err) {
        pesanTabAsal = `Tab asal gagal mengambilnya: ${err.message}`;
      }
    }

    // Urutan penjelasan: apa yang menghalangi lebih dulu, baru kata server.
    const alasan = pesanTabAsal || alasanTabAsal() || (await alasanGagal(img.url));
    box.innerHTML =
      `<span class="fail">${escapeHtml(alasan || 'Pratinjau gagal dimuat.')}<br />` +
      '<button type="button" class="mini act-retry">Coba lagi</button></span>';
  });

  enqueueThumb(thumbImg, img.blobUrl || proxyUrl(img.url));
}

// Kartu baru dimuat (pratinjau + metadata) saat mendekati layar.
const cardObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const card = entry.target;
      cardObserver.unobserve(card);
      const img = state.images.find((i) => i.id === card.dataset.id);
      if (!img) continue;
      mountThumb(card, img);
      queueMeta(img);
    }
  },
  { rootMargin: '400px 0px' }
);

function renderGrid() {
  el.empty.hidden = state.visible.length > 0;
  thumbQueue.pending.length = 0;
  cardObserver.disconnect();
  const frag = document.createDocumentFragment();

  for (const img of state.visible) {
    const card = document.createElement('article');
    card.className = `card${img.selected ? ' selected' : ''}`;
    card.dataset.id = img.id;

    const dims = img.w ? `${img.w}×${img.h}` : img.attrWidth ? `${img.attrWidth}×${img.attrHeight || '?'}` : '…';

    card.innerHTML = `
      <input class="pick" type="checkbox" ${img.selected ? 'checked' : ''} aria-label="Pilih ${escapeHtml(img.name)}" />
      <div class="badges">
        <span class="badge">${escapeHtml(img.format)}</span>
        <span class="badge src">${escapeHtml(img.source)}</span>
      </div>
      <div class="thumb">
        <img alt="${escapeHtml(img.alt || img.name)}" />
      </div>
      <div class="meta">
        <div class="fname" title="${escapeHtml(img.url)}">${escapeHtml(img.name)}</div>
        <div class="sub">
          <span class="dim">${dims}</span>
          <span class="size">${formatBytes(img.size)}</span>
        </div>
        <div class="card-actions">
          <a class="mini act-unduh" href="${proxyUrl(img.url, { download: true, name: img.name })}" download>Unduh</a>
          <button class="mini act-copy" type="button">Salin URL</button>
        </div>
      </div>`;

    frag.appendChild(card);
  }

  el.grid.replaceChildren(frag);
  for (const card of el.grid.children) cardObserver.observe(card);
}

// -------------------------------------------- metadata bertahap (ukuran/tipe)
//
// Ukuran & tipe berkas hanya diambil untuk gambar yang benar-benar dilihat
// pengguna. Menembak ratusan permintaan HEAD sekaligus membuat situs besar
// (mis. Wikimedia) langsung membalas 429 Too Many Requests.

let metaQueue = [];
let metaBusy = false;
let metaTimer = null;

function queueMeta(img) {
  if (img.metaQueued || img.size !== null) return;
  img.metaQueued = true;
  metaQueue.push(img);
  state.metaTotal += 1;
  clearTimeout(metaTimer);
  metaTimer = setTimeout(drainMeta, 250);
}

async function drainMeta() {
  if (metaBusy) return;
  metaBusy = true;
  try {
    while (metaQueue.length) {
      const batch = metaQueue.splice(0, 20);
      try {
        const res = await fetch('/api/meta', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: batch.map((img) => ({ id: img.id, url: img.url })),
            referer: state.pageUrl,
          }),
        });
        const data = await res.json();
        for (const r of data.results || []) {
          const img = state.images.find((x) => x.id === r.id);
          if (!img) continue;
          img.size = r.size;
          img.contentType = r.contentType;
          img.reachable = r.ok;
          if (r.format && r.format !== 'lainnya') img.format = r.format;
          patchCard(img);
        }
      } catch {
        for (const img of batch) img.metaQueued = false;
      }
      state.metaDone += batch.length;
      renderStats();
    }
  } finally {
    metaBusy = false;
    state.metaTotal = 0;
    state.metaDone = 0;
    renderStats();
  }
}

// Tombol manual: ukur seluruh gambar (perlu untuk filter ukuran & total unduhan).
async function measureAll() {
  const rest = state.images.filter((i) => i.size === null && !i.metaQueued);
  if (!rest.length) return toast('Semua gambar sudah terukur.', 'ok');
  toast(`Mengukur ${rest.length} gambar… mohon tunggu.`);
  for (const img of rest) queueMeta(img);
  clearTimeout(metaTimer);
  await drainMeta();
  buildFormatOptions();
  applyFilters();
  toast('Pengukuran selesai.', 'ok');
}

function patchCard(img) {
  const card = el.grid.querySelector(`.card[data-id="${img.id}"]`);
  if (!card) return;
  const sizeEl = card.querySelector('.size');
  if (sizeEl) sizeEl.textContent = formatBytes(img.size);
  const badge = card.querySelector('.badge');
  if (badge) badge.textContent = img.format;
}

function renderStats() {
  const total = state.images.length;
  const shown = state.visible.length;
  const picked = state.images.filter((i) => i.selected);
  const known = picked.filter((i) => Number.isFinite(i.size));
  const bytes = known.reduce((s, i) => s + i.size, 0);

  el.stats.innerHTML = [
    `<span class="stat">Terdeteksi <b>${total}</b></span>`,
    `<span class="stat">Ditampilkan <b>${shown}</b></span>`,
    `<span class="stat accent">Terpilih <b>${picked.length}</b></span>`,
    `<span class="stat">Perkiraan unduhan <b>${formatBytes(bytes)}</b>${
      known.length < picked.length ? ' +' : ''
    }</span>`,
    state.metaTotal
      ? `<span class="stat">Mengukur berkas… <b>${state.metaDone}/${state.metaTotal}</b></span>`
      : '',
  ].join('');

  el.btnZip.disabled = picked.length === 0;
  el.zipLabel.textContent = picked.length
    ? `Unduh ${picked.length} gambar (ZIP)`
    : 'Unduh terpilih (ZIP)';
}

// ------------------------------------------------------------- interaksi

el.grid.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const img = state.images.find((i) => i.id === card.dataset.id);
  if (!img) return;

  if (e.target.classList.contains('pick')) {
    img.selected = e.target.checked;
    card.classList.toggle('selected', img.selected);
    renderStats();
    return;
  }
  if (e.target.classList.contains('act-copy')) {
    navigator.clipboard.writeText(img.url).then(
      () => toast('URL disalin.', 'ok'),
      () => toast('Gagal menyalin.', 'bad')
    );
    return;
  }
  if (e.target.classList.contains('act-retry')) {
    mountThumb(card, img);
    return;
  }

  if (e.target.classList.contains('act-unduh')) {
    // Selalu ditangani sendiri: kalau server gagal, browser jangan sampai
    // menyimpan pesan galat JSON sebagai berkas (dulu muncul sebagai img.json).
    e.preventDefault();
    unduhSatu(img, e.target);
    return;
  }
  if (e.target.closest('.thumb') && !img.broken) openLightbox(img);
});

function simpanBlob(blob, nama) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nama;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Unduh satu gambar: pakai yang sudah ada di memori bila ada, kalau tidak
// lewat server, dan bila server gagal — coba tab asal yang masih login.
async function unduhSatu(img, tombol) {
  const teksAsli = tombol.textContent;
  tombol.textContent = 'Mengunduh…';
  try {
    if (img.blob) {
      simpanBlob(img.blob, img.name);
      return;
    }

    const res = await fetch(proxyUrl(img.url, { download: true, name: img.name }));
    if (res.ok) {
      simpanBlob(await res.blob(), img.name);
      return;
    }

    const data = await res.json().catch(() => ({}));
    if (bisaMintaKeTabAsal() && tabAsalVersi >= 2) {
      tombol.textContent = 'Lewat tab asal…';
      const blob = await mintaGambarKeTabAsal(img.url);
      img.blob = blob;
      img.blobUrl = URL.createObjectURL(blob);
      img.size = blob.size;
      patchCard(img);
      simpanBlob(blob, img.name);
      return;
    }
    toast(alasanTabAsal() || data.error || 'Gambar tidak bisa diunduh.', 'bad');
  } catch (err) {
    toast(err.message || 'Gambar tidak bisa diunduh.', 'bad');
  } finally {
    tombol.textContent = teksAsli;
  }
}

function setSelection(list, value) {
  for (const img of list) img.selected = typeof value === 'function' ? value(img) : value;
  renderGrid();
  renderStats();
}

$('#sel-all').addEventListener('click', () => setSelection(state.visible, true));
$('#sel-none').addEventListener('click', () => setSelection(state.images, false));
$('#sel-invert').addEventListener('click', () => setSelection(state.visible, (i) => !i.selected));

$('#measure-all').addEventListener('click', measureAll);

$('#copy-urls').addEventListener('click', () => {
  const picked = state.images.filter((i) => i.selected);
  if (!picked.length) return toast('Belum ada gambar yang dipilih.', 'bad');
  navigator.clipboard.writeText(picked.map((i) => i.url).join('\n')).then(
    () => toast(`${picked.length} URL disalin.`, 'ok'),
    () => toast('Gagal menyalin.', 'bad')
  );
});

function blobKeDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('Gagal membaca gambar dari memori.'));
    fr.readAsDataURL(blob);
  });
}

el.btnZip.addEventListener('click', async () => {
  const picked = state.images.filter((i) => i.selected);
  if (!picked.length) return;

  // Gambar yang hanya bisa diambil lewat tab asal sudah ada di memori browser.
  // Server tidak bisa mengambilnya sendiri, jadi isinya dititipkan sebagai
  // data URI di dalam permintaan ZIP.
  const lewatMemori = picked.filter((i) => i.blob);
  if (lewatMemori.length) {
    const totalByte = lewatMemori.reduce((s, i) => s + i.blob.size, 0);
    // Vercel membatasi ukuran body permintaan (~4,5 MB); versi lokal jauh lebih lega.
    const lokal = ['localhost', '127.0.0.1'].includes(location.hostname);
    const batas = lokal ? 20 * 1024 * 1024 : 3 * 1024 * 1024;
    if (totalByte > batas) {
      toast(
        `Gambar dari tab asal terlalu besar untuk satu ZIP (${formatBytes(totalByte)}, batas ${formatBytes(batas)}). ` +
          (lokal ? 'Pilih lebih sedikit, atau unduh satu per satu.' : 'Pilih lebih sedikit, atau pakai versi lokal.'),
        'bad'
      );
      return;
    }
    toast(`Menyiapkan ${lewatMemori.length} gambar dari memori…`);
    try {
      await Promise.all(
        lewatMemori.map(async (i) => {
          if (!i.dataUrl) i.dataUrl = await blobKeDataUrl(i.blob);
        })
      );
    } catch (err) {
      toast(err.message, 'bad');
      return;
    }
  }

  let host = 'gambar';
  try {
    host = new URL(state.pageUrl).hostname.replace(/^www\./, '');
  } catch {
    /* pakai nama bawaan */
  }
  const stamp = new Date().toISOString().slice(0, 10);

  el.zipPayload.value = JSON.stringify({
    items: picked.map((i) => ({ url: i.dataUrl || i.url, name: i.name })),
    referer: state.pageUrl,
    zipName: `${host}-${stamp}`,
  });
  el.zipForm.submit();
  toast(`Menyiapkan ZIP berisi ${picked.length} gambar… unduhan akan mulai otomatis.`, 'ok');
});

for (const input of [el.fSearch, el.fFormat, el.fMinW, el.fMinKb, el.fSort, el.fHideTiny]) {
  input.addEventListener('input', applyFilters);
}

el.form.addEventListener('submit', scan);

// ------------------------------------------------------------- tempel HTML

el.btnScanPaste.addEventListener('click', () => {
  const html = el.pasteHtml.value.trim();
  if (!html) {
    toast('Kotak HTML masih kosong.', 'bad');
    el.pasteHtml.focus();
    return;
  }
  if (!el.url.value.trim()) {
    toast('Isi dulu alamat halamannya di kotak atas.', 'bad');
    el.url.focus();
    return;
  }
  scan(null, html);
});

el.btnClearPaste.addEventListener('click', () => {
  el.pasteHtml.value = '';
  updatePasteCount();
  el.pasteHtml.focus();
});

function updatePasteCount() {
  const n = el.pasteHtml.value.length;
  el.pasteCount.textContent = n ? `${n.toLocaleString('id-ID')} karakter ditempel` : '';
}

el.pasteHtml.addEventListener('input', updatePasteCount);

// ------------------------------------------------------------- lightbox

let gambarLightbox = null;

function openLightbox(img) {
  gambarLightbox = img;
  el.lbImg.src = img.blobUrl || proxyUrl(img.url);
  el.lbInfo.textContent = `${img.name} · ${img.w ? `${img.w}×${img.h} · ` : ''}${formatBytes(img.size)} · ${img.format.toUpperCase()}`;
  el.lightbox.hidden = false;
}

// Unduhan dari lightbox lewat jalur yang sama dengan tombol di kartu, supaya
// pesan galat tidak pernah ikut tersimpan sebagai berkas.
el.lbDl.addEventListener('click', (e) => {
  e.preventDefault();
  if (gambarLightbox) unduhSatu(gambarLightbox, el.lbDl);
});

function closeLightbox() {
  el.lightbox.hidden = true;
  el.lbImg.removeAttribute('src');
}

el.lbClose.addEventListener('click', closeLightbox);
el.lightbox.addEventListener('click', (e) => {
  if (e.target === el.lightbox) closeLightbox();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.lightbox.hidden) closeLightbox();
});

// --------------------------------------------------- ambil langsung dari tab
//
// Bookmarklet dijalankan di halaman yang ingin diambil: ia membuka aplikasi ini
// di tab baru lalu mengirim HTML yang SUDAH dirender lewat postMessage. Tidak
// lewat server, jadi tidak ada urusan CORS, tidak ada yang perlu disalin, dan
// halaman yang perlu login tetap terbaca karena isinya diambil dari tab yang
// memang sudah login.

function bookmarkletCode() {
  const asal = location.origin;
  return (
    'javascript:(function(){' +
    `var A=${JSON.stringify(asal)};` +
    "var w=window.open(A+'/?collect=1','_blank');" +
    "if(!w){alert('Popup diblokir. Izinkan popup untuk situs ini lalu klik lagi.');return;}" +
    "var d={type:'ig-collect',url:location.href,title:document.title," +
    'html:document.documentElement.outerHTML};' +
    'var n=0,t=setInterval(function(){n++;try{w.postMessage(d,A);}catch(e){}' +
    'if(n>50){clearInterval(t);}},400);' +
    // Tab ini tetap melayani permintaan gambar dari aplikasi. Karena fetch
    // dijalankan DI SINI, cookie sesi situs ikut terbawa — itulah cara gambar
    // yang butuh login tetap bisa diambil.
    "window.addEventListener('message',function(e){" +
    "if(e.origin!==A){return;}" +
    "if(e.data==='ig-collect-ok'){clearInterval(t);return;}" +
    'var m=e.data;if(!m){return;}' +
    // Jawaban sapaan: dipakai aplikasi untuk tahu bookmark ini sudah versi baru.
    "if(m.type==='ig-ping'){w.postMessage({type:'ig-pong',versi:2},A);return;}" +
    "if(m.type!=='ig-fetch'){return;}" +
    "fetch(m.url,{credentials:'include',mode:'cors'})" +
    '.then(function(r){if(!r.ok){throw new Error("HTTP "+r.status);}' +
    'return r.blob();})' +
    '.then(function(b){return b.arrayBuffer().then(function(ab){' +
    "w.postMessage({type:'ig-bytes',id:m.id,ok:true,tipe:b.type,bytes:ab},A,[ab]);});})" +
    '.catch(function(err){' +
    "w.postMessage({type:'ig-bytes',id:m.id,ok:false,pesan:String(err.message||err)},A);});" +
    '});' +
    '})()'
  );
}

function siapkanBookmarklet() {
  const kode = bookmarkletCode();
  const tautan = $('#bookmarklet');
  tautan.setAttribute('href', kode);

  $('#copy-bookmarklet').addEventListener('click', () => {
    navigator.clipboard.writeText(kode).then(
      () =>
        toast(
          'Kode disalin. Buat bookmark baru, tempel kode ini sebagai alamatnya.',
          'ok'
        ),
      () => toast('Gagal menyalin kode.', 'bad')
    );
  });
}

// --------------------------------------- ambil gambar lewat tab asal (login)
//
// Bila proxy server ditolak situs sumber (gambar butuh sesi login), aplikasi
// meminta tab asal — yang masih terbuka dan masih login — untuk mengambil
// gambarnya, lalu mengirim balik isinya.

let tabAsal = null; // window pengirim bookmarklet
let tabAsalVersi = 0; // 0 = belum menjawab sapaan (bookmark versi lama)
let nomorPermintaan = 0;
const menungguBytes = new Map();

// Menyapa tab asal untuk memastikan bookmark-nya sudah versi yang bisa
// mengambilkan gambar. Bookmark lama tidak menjawab, dan itu perlu
// disampaikan ke pengguna — bukan dibiarkan gagal tanpa sebab.
function sapaTabAsal() {
  if (!bisaMintaKeTabAsal()) return;
  try {
    tabAsal.postMessage({ type: 'ig-ping' }, '*');
  } catch {
    /* abaikan */
  }
}

// Pesan yang menjelaskan kenapa gambar berproteksi belum bisa diambil.
function alasanTabAsal() {
  if (!bisaMintaKeTabAsal()) {
    return (
      'Gambar ini perlu sesi login. Agar bisa diambil, buka halamannya lalu klik bookmark ' +
      '"Ambil Gambar" — jangan tutup tab itu selama mengunduh.'
    );
  }
  if (tabAsalVersi < 2) {
    return (
      'Bookmark "Ambil Gambar" Anda masih versi lama sehingga belum bisa mengambilkan gambar ' +
      'berproteksi. Buka Image Grabber, seret ulang tombol birunya ke bilah bookmark ' +
      '(timpa yang lama), lalu ulangi dari halaman sumber.'
    );
  }
  return '';
}

function bisaMintaKeTabAsal() {
  try {
    return Boolean(tabAsal && !tabAsal.closed);
  } catch {
    return false;
  }
}

function mintaGambarKeTabAsal(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (!bisaMintaKeTabAsal()) {
      reject(new Error('Tab asal sudah tertutup.'));
      return;
    }
    const id = `p${++nomorPermintaan}`;
    const batas = setTimeout(() => {
      menungguBytes.delete(id);
      reject(new Error('Tab asal tidak menjawab.'));
    }, timeoutMs);

    menungguBytes.set(id, { resolve, reject, batas });
    tabAsal.postMessage({ type: 'ig-fetch', id, url }, '*');
  });
}

function tanganiBytesMasuk(data) {
  const tunggu = menungguBytes.get(data.id);
  if (!tunggu) return;
  menungguBytes.delete(data.id);
  clearTimeout(tunggu.batas);
  if (data.ok && data.bytes) {
    tunggu.resolve(new Blob([data.bytes], { type: data.tipe || 'application/octet-stream' }));
  } else {
    tunggu.reject(new Error(data.pesan || 'Tab asal gagal mengambil gambar.'));
  }
}

// Menerima kiriman dari bookmarklet. Hanya dilayani bila tab ini memang dibuka
// olehnya (?collect=1), supaya halaman lain tidak bisa menyuruh kita memindai.
function dengarkanKiriman() {
  const menunggu = new URLSearchParams(location.search).get('collect') === '1';
  if (!menunggu) return;

  el.pageInfo.hidden = false;
  el.pageInfo.textContent = 'Menunggu isi halaman dikirim dari tab sebelumnya…';

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data) return;

    if (data.type === 'ig-bytes') {
      tanganiBytesMasuk(data);
      return;
    }

    if (data.type === 'ig-pong') {
      tabAsalVersi = Number(data.versi) || 1;
      return;
    }

    if (data.type !== 'ig-collect') return;
    if (typeof data.html !== 'string' || typeof data.url !== 'string') return;

    // Simpan tab pengirim: dia yang punya sesi login ke situs sumber.
    tabAsal = event.source;
    tabAsalVersi = 0;
    sapaTabAsal();

    // Beri tahu pengirim agar berhenti mengulang.
    try {
      event.source?.postMessage('ig-collect-ok', event.origin);
    } catch {
      /* pengirim mungkin sudah tertutup */
    }

    if (state.images.length || el.btnScan.disabled) return; // sudah diproses
    el.url.value = data.url;
    el.pasteHtml.value = data.html;
    updatePasteCount();
    toast(`Isi halaman diterima (${(data.html.length / 1024).toFixed(0)} KB). Memindai…`, 'ok');
    scan(null, data.html);
  });
}

// ------------------------------------------------------- gerbang kata sandi
//
// Hanya muncul bila server dijalankan dengan IG_PASSWORD (mis. saat di-deploy
// ke Vercel). Di komputer sendiri aplikasi tetap terbuka tanpa login.

function showGate(message = '') {
  el.gate.hidden = false;
  el.gateError.hidden = !message;
  el.gateError.textContent = message;
  el.gatePassword.focus();
}

function hideGate() {
  el.gate.hidden = true;
  el.gatePassword.value = '';
}

async function checkSession() {
  try {
    const res = await fetch('/api/session');
    if (!res.ok) return;
    const data = await res.json();
    if (data.locked && !data.authorized) showGate();
  } catch {
    /* offline / endpoint tak ada — biarkan terbuka */
  }
}

el.gateForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = el.gatePassword.value;
  if (!password) return;
  el.gateSubmit.disabled = true;
  el.gateSubmit.textContent = 'Memeriksa…';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      hideGate();
      toast('Berhasil masuk.', 'ok');
      // Kiriman dari bookmarklet yang datang saat masih terkunci: lanjutkan.
      if (el.pasteHtml.value.trim() && el.url.value.trim() && !state.images.length) {
        scan(null, el.pasteHtml.value);
      } else {
        el.url.focus();
      }
    } else {
      showGate(data.error || 'Kata sandi salah.');
    }
  } catch {
    showGate('Gagal menghubungi server.');
  } finally {
    el.gateSubmit.disabled = false;
    el.gateSubmit.textContent = 'Masuk';
  }
});

checkSession();
siapkanBookmarklet();
dengarkanKiriman();
renderHistory();
el.url.focus();
