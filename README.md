# Image Grabber

Aplikasi lokal untuk **mendeteksi semua gambar di sebuah halaman web** lalu **mengunduhnya secara massal (ZIP) atau memilih satu per satu**.

Tanpa dependency sama sekali — hanya Node.js 18+ (di komputer ini sudah ada Node v24).

## Menjalankan

Klik dua kali `jalankan.cmd` — browser terbuka sendiri di **http://localhost:3025**. Atau lewat terminal:

```bash
node server.js
```

Biarkan jendela hitam itu terbuka selama aplikasi dipakai; menutupnya = mematikan server. Ganti port dengan `set PORT=4000` bila perlu (kalau 3025 terpakai, aplikasi otomatis pindah ke 3026, 3027, dan seterusnya).

## Menjalankan di komputer lain

1. **Salin seluruh isi folder** `image-grabber` (server.js, folder `lib`, folder `public`, `jalankan.cmd`, `package.json`) — bukan hanya `jalankan.cmd`. Menyalin lewat ZIP paling aman.
2. Komputer tujuan harus punya **Node.js 18 atau lebih baru**. Cek dengan membuka Command Prompt lalu ketik `node -v`. Kalau muncul pesan "not recognized", unduh installer **LTS** di <https://nodejs.org>, pasang dengan pilihan bawaan (biarkan *Add to PATH* tercentang), lalu **buka ulang** Command Prompt.
3. Klik dua kali `jalankan.cmd`. Berkas ini portabel: ia pindah sendiri ke folder tempat ia berada, mencari Node di PATH maupun di lokasi pemasangan umum, dan **berhenti dengan pesan yang jelas** (jendela tidak langsung tertutup) bila ada yang kurang.

Tidak ada `npm install`, tidak ada koneksi internet yang dibutuhkan untuk pemasangan — hanya untuk mengambil gambar dari situs, tentu saja.

Tanpa memasang Node.js sama sekali? Salin `node.exe` portabel ke dalam folder `image-grabber` (atau ke subfolder `node\`); launcher akan memakainya.

**Catatan:** server hanya mendengarkan di `127.0.0.1`, jadi tidak bisa diakses komputer lain di jaringan. Bila memang ingin dibuka dari HP/komputer lain di jaringan lokal, jalankan `set HOST=0.0.0.0 & node server.js` — sadari aplikasi ini tidak punya autentikasi.

## Cara pakai

1. Tempel alamat halaman (boleh tanpa `https://`, mis. `antaranews.com/foto`) lalu tekan **Pindai Halaman**.
2. Gambar muncul sebagai kartu: pratinjau, nama berkas, dimensi asli, ukuran berkas, format, dan sumber temuan.
3. Saring & urutkan sesuai kebutuhan (kata kunci, format, lebar minimum, ukuran minimum, sembunyikan ikon mungil).
4. Centang gambar yang diinginkan — atau **Pilih semua tampil** untuk unduhan massal.
5. Tekan **Unduh N gambar (ZIP)**. Bisa juga **Unduh** per kartu, atau **Salin URL terpilih**.

Klik pratinjau untuk melihat gambar ukuran penuh.

## Versi online (Vercel)

Aplikasi yang sama berjalan di **<https://image-grabber-one.vercel.app>**, terkunci kata sandi — buka dari komputer atau HP mana pun tanpa memasang apa pun.

Kata sandi disimpan sebagai environment variable `IG_PASSWORD` di Vercel. Mengganti kata sandi:

```bash
vercel env rm IG_PASSWORD production
```

lalu tambahkan lagi dengan nilai baru (`vercel env add IG_PASSWORD production`) dan deploy ulang (`vercel --prod`). Setelah masuk, sesi tersimpan sebagai cookie selama 30 hari.

Struktur di Vercel: berkas di `public/` disajikan statis, sedangkan `api/*.js` adalah serverless function tipis yang memanggil handler yang sama di `lib/handlers.js`. Jadi satu kode dipakai dua-duanya — versi lokal tidak berubah perilakunya.

### Perbedaan versi online vs lokal

| Hal | Lokal | Vercel |
|---|---|---|
| Kata sandi | tidak ada (kecuali `IG_PASSWORD` diisi) | wajib |
| Batas waktu unduhan ZIP | tidak ada | ~45 detik, lalu ZIP ditutup rapi |
| Ukuran ZIP | tidak dibatasi | teruji sampai **17 MB / 60 gambar dalam 30 detik** |
| Pembatas laju per host | efektif | lemah (tiap function berjalan terpisah) |
| Tempel HTML | halaman sangat besar pun bisa | body permintaan dibatasi ~4,5 MB |

Bila batas waktu tercapai saat mengunduh ZIP, berkasnya **tetap utuh dan bisa dibuka**; jumlah gambar yang tidak sempat masuk dicatat di `_daftar-unduhan.txt` di dalam ZIP, tinggal pilih sisanya lalu unduh lagi. Untuk unduhan yang benar-benar besar, versi lokal tetap yang paling nyaman.

## Kalau yang terdeteksi cuma ikon dan logo

Dua sebab tersering, dan aplikasi ini sekarang **mengenali keduanya lalu menjelaskannya** di kotak peringatan kuning:

1. **Halaman butuh login.** Server dialihkan ke halaman login, jadi yang terpindai adalah halaman login. Terlihat dari peringatan yang menyebut `dialihkan ke /login`.
2. **Gambar dimuat JavaScript setelah halaman terbuka** — umum pada daftar produk, galeri, dan dasbor. Petunjuk terkuatnya: ada tag `<img>` yang alamatnya masih berupa placeholder template seperti `${mobileImgUrl}` atau `{{ foto }}`. Placeholder semacam itu dibuang dari hasil (pasti gagal diunduh) dan dihitung sebagai bukti.

Keduanya diselesaikan dengan cara yang sama: **mode Tempel HTML**, tapi wajib menyalin dari DOM yang sudah dirender — bukan Ctrl+U.

```js
copy(document.documentElement.outerHTML)
```

Jalankan di DevTools (F12) → Console, saat halaman sudah terbuka penuh dan sudah login. Gulir dulu sampai bawah bila gambarnya lazy-load, supaya semuanya sempat termuat.

Beacon pelacak (Facebook Pixel, Google Analytics, dan sejenisnya) otomatis dibuang karena bukan gambar yang dicari.

> **Catatan:** untuk halaman internal atau yang berisi data pribadi, pakai **versi lokal**. Menempelkan HTML-nya ke versi Vercel berarti mengirim isi halaman itu ke server.

## Kalau situs menolak (HTTP 403)

Sebagian situs (mis. `presidenri.go.id`) berada di balik Cloudflare dengan **challenge** — servernya membalas `403` + header `Cf-Mitigated: challenge` dan hanya mau melayani setelah browser sungguhan mengerjakan verifikasi JavaScript. Tidak ada kombinasi header yang bisa menembusnya, dan aplikasi ini memang tidak berusaha mengakalinya.

Jalan keluarnya ada di panel **"Situs menolak (403) atau isinya dirender JavaScript? Tempel HTML halaman"** — panel ini terbuka sendiri saat pemindaian ditolak:

1. Buka halaman itu di browser sampai termuat penuh (verifikasi Cloudflare selesai di sana).
2. <kbd>Ctrl</kbd>+<kbd>U</kbd> → <kbd>Ctrl</kbd>+<kbd>A</kbd> → <kbd>Ctrl</kbd>+<kbd>C</kbd>.
   Untuk halaman yang isinya dirender JavaScript, pakai DevTools → Console → `copy(document.documentElement.outerHTML)` supaya yang tersalin adalah DOM setelah render.
3. Pastikan kotak alamat di atas berisi URL halaman itu (dipakai untuk menyelesaikan URL relatif dan sebagai `Referer` saat mengunduh), lalu tempel HTML-nya dan tekan **Pindai dari HTML**.

Setelah itu semua fitur berjalan normal: pratinjau, filter, unduh satuan, dan ZIP massal.

Untuk 403 yang sifatnya cuma penyaringan header, aplikasi sudah menirukan header navigasi Chrome lengkap (`Sec-Fetch-*`, `sec-ch-ua`, `Upgrade-Insecure-Requests`) dan otomatis mencoba ulang sekali dengan profil header polos sebelum menyerah.

## Yang dideteksi

| Sumber | Keterangan |
|---|---|
| `img` | `src`, `srcset` (varian terbesar), dan belasan atribut lazy-load (`data-src`, `data-original`, `data-lazy-src`, …) |
| `picture` | `<source srcset>` di dalam `<picture>` |
| `poster` | atribut `poster` pada `<video>` |
| `meta` | Open Graph & Twitter Card (`og:image`, `twitter:image`) |
| `ikon` | favicon, `apple-touch-icon`, `preload as=image` |
| `css` | `background-image: url(...)` pada atribut `style` maupun blok `<style>` |
| `tautan` | `<a href="...jpg">` yang menunjuk langsung ke berkas gambar |
| `dalam` | URL gambar yang tertanam di script/JSON — hanya bila **Pemindaian dalam** dinyalakan |

Gambar `data:image/...` (base64 inline) ikut terdeteksi dan bisa diunduh.

## Catatan teknis

- **Server sebagai proxy.** Browser tidak boleh membaca halaman lintas domain (CORS), jadi pengambilan HTML, pratinjau, dan unduhan semuanya lewat server Node lokal. Header `Referer`/`Origin` diteruskan agar situs yang memblokir hotlink tetap mau melayani.
- **Sopan terhadap situs sumber.** Maksimal 4 permintaan bersamaan per host dengan jeda ~90 ms, plus percobaan ulang otomatis saat dibalas `429`/`503`. Pratinjau dan pengukuran berkas hanya dijalankan untuk kartu yang mendekati layar — halaman dengan ratusan gambar (mis. Wikipedia) tidak lagi memicu blokir laju.
- **Tombol "Ukur semua ukuran"** memaksa pengukuran seluruh gambar; diperlukan bila ingin memfilter berdasarkan ukuran berkas atau melihat total unduhan yang akurat.
- **ZIP ditulis sendiri** (`lib/zip.js`, metode *store*) dan dialirkan langsung ke browser, jadi tidak ada berkas sementara di disk. Di dalamnya disertakan `_daftar-unduhan.txt` berisi ringkasan berhasil/gagal.
- Berkas bernama sama otomatis diberi akhiran ` (2)`, ` (3)`, dan ekstensi ditambal dari `Content-Type` bila URL tidak punya ekstensi.

## Batasan

- Halaman yang isinya dirender JavaScript (SPA) hanya terbaca bila URL gambarnya ada di HTML awal — nyalakan **Pemindaian dalam**, atau pakai mode **Tempel HTML** dengan `copy(document.documentElement.outerHTML)`.
- Situs di balik Cloudflare/anti-bot membalas `403`; tidak ada upaya melewati proteksi tersebut — pakai mode **Tempel HTML**.
- Server ini mengambil URL apa pun yang diberikan (termasuk alamat jaringan lokal). Jalankan hanya di komputer sendiri, jangan diekspos ke internet.
- Gunakan dengan menghormati hak cipta dan ketentuan layanan situs sumber.

## Struktur

```
image-grabber/
├── server.js          # server lokal: berkas statis + routing /api/*
├── lib/
│   ├── handlers.js    # seluruh logika API (dipakai lokal & Vercel)
│   ├── scraper.js     # ekstraksi URL gambar dari HTML
│   ├── net.js         # pembatas laju per host + retry 429/503
│   ├── zip.js         # penulis ZIP streaming tanpa dependency
│   └── auth.js        # gerbang kata sandi opsional (env IG_PASSWORD)
├── api/               # serverless function Vercel (pembungkus tipis)
│   ├── scan.js  meta.js  img.js  zip.js
│   └── login.js  session.js  _wrap.js
├── public/            # antarmuka (index.html, style.css, app.js)
├── vercel.json        # output statis public/ + maxDuration per function
└── jalankan.cmd       # pintasan menjalankan di Windows
```
