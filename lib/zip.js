'use strict';

// Penulis ZIP minimalis tanpa dependency (metode "store" / tanpa kompresi).
// Gambar sudah terkompresi, jadi menyimpan mentah praktis tidak menambah ukuran
// dan membuat kita bisa streaming langsung ke response tanpa buffer besar.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

class ZipWriter {
  constructor(stream) {
    this.stream = stream;
    this.entries = [];
    this.offset = 0;
    this.names = new Set();
  }

  async #write(buf) {
    this.offset += buf.length;
    if (!this.stream.write(buf)) {
      await new Promise((resolve) => this.stream.once('drain', resolve));
    }
  }

  uniqueName(name) {
    if (!this.names.has(name)) {
      this.names.add(name);
      return name;
    }
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let i = 2;
    let candidate = `${base} (${i})${ext}`;
    while (this.names.has(candidate)) {
      i += 1;
      candidate = `${base} (${i})${ext}`;
    }
    this.names.add(candidate);
    return candidate;
  }

  async add(rawName, data) {
    const name = this.uniqueName(rawName);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const { time, day } = dosDateTime(new Date());
    const localOffset = this.offset;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // signature
    header.writeUInt16LE(20, 4); // versi minimum
    header.writeUInt16LE(0x0800, 6); // flag: nama berkas UTF-8
    header.writeUInt16LE(0, 8); // metode: store
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);

    await this.#write(header);
    await this.#write(nameBuf);
    await this.#write(data);

    this.entries.push({ nameBuf, crc, size: data.length, time, day, localOffset });
    return name;
  }

  async finish() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4); // dibuat oleh
      cd.writeUInt16LE(20, 6); // versi minimum
      cd.writeUInt16LE(0x0800, 8);
      cd.writeUInt16LE(0, 10);
      cd.writeUInt16LE(e.time, 12);
      cd.writeUInt16LE(e.day, 14);
      cd.writeUInt32LE(e.crc, 16);
      cd.writeUInt32LE(e.size, 20);
      cd.writeUInt32LE(e.size, 24);
      cd.writeUInt16LE(e.nameBuf.length, 28);
      cd.writeUInt16LE(0, 30); // extra
      cd.writeUInt16LE(0, 32); // komentar
      cd.writeUInt16LE(0, 34); // nomor disk
      cd.writeUInt16LE(0, 36); // atribut internal
      cd.writeUInt32LE(0, 38); // atribut eksternal
      cd.writeUInt32LE(e.localOffset, 42);
      await this.#write(cd);
      await this.#write(e.nameBuf);
    }

    const cdSize = this.offset - cdStart;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    await this.#write(eocd);
  }
}

module.exports = { ZipWriter, crc32 };
