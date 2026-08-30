'use strict';

// Gerbang kata sandi sederhana untuk deployment publik (Vercel).
//
// Aktif hanya bila environment variable IG_PASSWORD diisi — jadi saat
// dijalankan lokal lewat `node server.js` aplikasi tetap terbuka tanpa login.
// Kata sandi tidak pernah dikirim ulang oleh browser: setelah login, yang
// tersimpan adalah cookie berisi HMAC dari kata sandi. Cookie dipakai (bukan
// header) karena <img src> dan unduhan ZIP lewat <form> tidak bisa membawa
// header khusus.

const crypto = require('node:crypto');

const COOKIE_NAME = 'ig_auth';
const MAX_AGE_DAYS = 30;

// Nilai env sering membawa bawaan dari shell: newline/CR di ujung, atau tanda
// kutip yang ikut tersimpan. Dibersihkan supaya kata sandi yang benar tidak
// ditolak hanya karena karakter tak terlihat.
function password() {
  let v = String(process.env.IG_PASSWORD || '').trim();
  if (v.length > 1 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

function isEnabled() {
  return password().length > 0;
}

function tokenFor(pass) {
  return crypto.createHmac('sha256', 'image-grabber').update(pass).digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function readCookie(req, name) {
  const raw = req.headers?.cookie || '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return '';
}

function isAuthorized(req) {
  if (!isEnabled()) return true;
  return safeEqual(readCookie(req, COOKIE_NAME), tokenFor(password()));
}

// Dipanggil di awal setiap handler API.
function assertAuth(req) {
  if (isAuthorized(req)) return;
  throw Object.assign(new Error('Perlu kata sandi untuk memakai aplikasi ini.'), {
    status: 401,
    code: 'auth',
  });
}

function checkPassword(input) {
  return isEnabled() && safeEqual(String(input || ''), password());
}

function cookieHeader(secure) {
  const bits = [
    `${COOKIE_NAME}=${tokenFor(password())}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${MAX_AGE_DAYS * 24 * 60 * 60}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

module.exports = { assertAuth, isAuthorized, isEnabled, checkPassword, cookieHeader, COOKIE_NAME };
