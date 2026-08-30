'use strict';

// Pembatas laju sederhana: maksimal N permintaan bersamaan per host, plus
// percobaan ulang saat server sumber membalas 429/503. Tanpa ini, memuat
// ratusan pratinjau sekaligus membuat situs seperti Wikimedia langsung
// menolak dengan "Too Many Requests".

const MAX_PER_HOST = 4;
const MIN_GAP_MS = 90; // jeda minimum antar permintaan ke host yang sama
const queues = new Map(); // host -> { active, waiting[], last }

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'lain';
  }
}

function acquire(host) {
  let q = queues.get(host);
  if (!q) {
    q = { active: 0, waiting: [], last: 0 };
    queues.set(host, q);
  }
  const slot =
    q.active < MAX_PER_HOST
      ? ((q.active += 1), Promise.resolve())
      : new Promise((resolve) => q.waiting.push(resolve));

  // Setelah dapat slot, tahan sebentar bila permintaan sebelumnya baru saja jalan.
  return slot.then(() => {
    const now = Date.now();
    const wait = Math.max(0, q.last + MIN_GAP_MS - now);
    q.last = now + wait;
    return wait ? sleep(wait) : undefined;
  });
}

function release(host) {
  const q = queues.get(host);
  if (!q) return;
  const next = q.waiting.shift();
  if (next) next();
  else q.active = Math.max(0, q.active - 1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch dengan timeout, antrean per host, dan retry pada 429/503.
 * @param {string} url
 * @param {RequestInit} options
 * @param {{timeout?: number, retries?: number}} cfg
 */
async function politeFetch(url, options = {}, cfg = {}) {
  const { timeout = 20000, retries = 2 } = cfg;
  const host = hostOf(url);
  await acquire(host);
  try {
    let lastResponse;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeout);
      try {
        const res = await fetch(url, { ...options, signal: ac.signal, redirect: 'follow' });
        if (res.status !== 429 && res.status !== 503) return res;
        lastResponse = res;
        if (attempt === retries) return res;
        try {
          res.body?.cancel();
        } catch {
          /* abaikan */
        }
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 5000)
          : 600 * 2 ** attempt + Math.random() * 300;
        await sleep(wait);
      } finally {
        clearTimeout(timer);
      }
    }
    return lastResponse;
  } finally {
    release(host);
  }
}

module.exports = { politeFetch };
