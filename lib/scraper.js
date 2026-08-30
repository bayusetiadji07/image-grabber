'use strict';

// Ekstraksi URL gambar dari HTML mentah, tanpa dependency.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const IMG_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg|ico|tiff?|heic|jfif)(\?|#|$)/i;

const SRC_ATTRS = [
  'src',
  'data-src',
  'data-original',
  'data-original-src',
  'data-lazy',
  'data-lazy-src',
  'data-echo',
  'data-url',
  'data-image',
  'data-img',
  'data-thumb',
  'data-thumbnail',
  'data-hi-res-src',
  'data-fallback-src',
  'data-large-file',
  'data-full-url',
  'data-zoom-image',
];

const SRCSET_ATTRS = ['srcset', 'data-srcset', 'imagesrcset', 'data-lazy-srcset'];

function parseAttrs(tag) {
  const attrs = {};
  const re = /([\w:.-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  re.lastIndex = tag.indexOf(' ');
  if (re.lastIndex < 0) return attrs;
  while ((m = re.exec(tag))) {
    const key = m[1].toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    if (!(key in attrs)) attrs[key] = decodeEntities(val.trim());
  }
  return attrs;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x2F;/gi, '/')
    .replace(/&nbsp;/gi, ' ');
}

// Ambil kandidat terbesar dari sebuah srcset ("a.jpg 400w, b.jpg 800w").
function pickFromSrcset(value) {
  const out = [];
  for (const part of value.split(',')) {
    const bits = part.trim().split(/\s+/);
    if (!bits[0]) continue;
    const desc = bits[1] || '';
    let weight = 1;
    if (/w$/i.test(desc)) weight = parseFloat(desc);
    else if (/x$/i.test(desc)) weight = parseFloat(desc) * 1000;
    out.push({ url: bits[0], weight: Number.isFinite(weight) ? weight : 1 });
  }
  if (!out.length) return [];
  out.sort((a, b) => b.weight - a.weight);
  return [out[0].url];
}

function isUsable(raw) {
  if (!raw) return false;
  const v = raw.trim();
  if (!v) return false;
  if (/^(javascript:|about:|blob:|mailto:|tel:|#)/i.test(v)) return false;
  if (/^data:/i.test(v)) return /^data:image\//i.test(v);
  return true;
}

function guessNameFromUrl(url) {
  if (url.startsWith('data:')) {
    const type = /^data:image\/([a-z0-9+.-]+)/i.exec(url);
    return `gambar-inline.${(type ? type[1] : 'png').replace('svg+xml', 'svg')}`;
  }
  try {
    const u = new URL(url);
    let base = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (!base) base = u.hostname;
    return base;
  } catch {
    return 'gambar';
  }
}

/**
 * @param {string} html isi halaman
 * @param {string} baseUrl URL final halaman (setelah redirect)
 * @param {{deep?: boolean}} opts
 */
function extractImages(html, baseUrl, opts = {}) {
  const found = new Map(); // url absolut -> record
  let base = baseUrl;

  const baseTag = /<base\b[^>]*>/i.exec(html);
  if (baseTag) {
    const href = parseAttrs(baseTag[0]).href;
    if (href) {
      try {
        base = new URL(href, baseUrl).href;
      } catch {
        /* biarkan base semula */
      }
    }
  }

  const push = (raw, source, extra = {}) => {
    if (!isUsable(raw)) return;
    let abs;
    if (raw.startsWith('data:')) {
      abs = raw;
    } else {
      try {
        abs = new URL(raw, base).href;
      } catch {
        return;
      }
      if (!/^https?:/i.test(abs)) return;
    }
    const existing = found.get(abs);
    if (existing) {
      if (!existing.alt && extra.alt) existing.alt = extra.alt;
      return;
    }
    found.set(abs, {
      url: abs,
      source,
      alt: extra.alt || '',
      attrWidth: extra.width || null,
      attrHeight: extra.height || null,
      name: guessNameFromUrl(abs),
    });
  };

  // 1. <img> dan turunannya
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    const extra = {
      alt: a.alt || a.title || '',
      width: parseInt(a.width, 10) || null,
      height: parseInt(a.height, 10) || null,
    };
    for (const attr of SRC_ATTRS) if (a[attr]) push(a[attr], 'img', extra);
    for (const attr of SRCSET_ATTRS) {
      if (a[attr]) for (const u of pickFromSrcset(a[attr])) push(u, 'img', extra);
    }
  }

  // 2. <source> di dalam <picture>
  for (const m of html.matchAll(/<source\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    for (const attr of SRCSET_ATTRS) {
      if (a[attr]) for (const u of pickFromSrcset(a[attr])) push(u, 'picture');
    }
    if (a.src && /image/i.test(a.type || 'image')) push(a.src, 'picture');
  }

  // 3. poster video
  for (const m of html.matchAll(/<video\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    if (a.poster) push(a.poster, 'poster');
  }

  // 4. meta open-graph / twitter
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    const key = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (/^(og:image|og:image:url|og:image:secure_url|twitter:image|twitter:image:src|image)$/.test(key)) {
      push(a.content, 'meta');
    }
  }

  // 5. favicon / apple-touch-icon / preload gambar
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    const rel = (a.rel || '').toLowerCase();
    if (/(^|\s)(icon|shortcut icon|apple-touch-icon|apple-touch-icon-precomposed|image_src|preload)(\s|$)/.test(rel)) {
      if (rel.includes('preload') && (a.as || '') !== 'image') continue;
      push(a.href, 'ikon');
      for (const attr of SRCSET_ATTRS) {
        if (a[attr]) for (const u of pickFromSrcset(a[attr])) push(u, 'ikon');
      }
    }
  }

  // 6. background-image pada atribut style dan blok <style>
  const cssChunks = [];
  for (const m of html.matchAll(/\bstyle\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    cssChunks.push(decodeEntities(m[2] ?? m[3] ?? ''));
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    cssChunks.push(m[1]);
  }
  for (const css of cssChunks) {
    for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
      push(m[2].trim(), 'css');
    }
  }

  // 7. tautan langsung ke berkas gambar
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    if (a.href && IMG_EXT.test(a.href)) push(a.href, 'tautan');
  }

  // 8. mode dalam: sisir seluruh teks (JSON/JS inline) untuk URL berekstensi gambar
  if (opts.deep) {
    const re = /(https?:\\?\/\\?\/[^\s"'`<>()\\]+?\.(?:jpe?g|png|gif|webp|avif|bmp|svg|ico))/gi;
    for (const m of html.matchAll(re)) {
      push(m[1].replace(/\\\//g, '/'), 'dalam');
    }
    const rel = /["'(](\/[^\s"'`<>()]+?\.(?:jpe?g|png|gif|webp|avif|bmp|svg|ico))["')]/gi;
    for (const m of html.matchAll(rel)) push(m[1], 'dalam');
  }

  return { images: [...found.values()], base };
}

function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1].trim()).slice(0, 200) : '';
}

module.exports = { extractImages, extractTitle, guessNameFromUrl, UA, IMG_EXT };
