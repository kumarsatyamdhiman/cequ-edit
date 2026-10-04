import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { sniff, processUpload, imageSize } from '../images.mjs';

const MAC = process.platform === 'darwin';
// header-only JPEG (SOI, APP0, SOF0 3000×2000, EOI): enough for format and size checks without an encoder
function jpegHeader(w, h) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

// tiny solid-colour PNG encoder so fixtures need no files in the repo
function png(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0xc8)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const dir = mkdtempSync(join(tmpdir(), 'cequ-img-'));
const out = mkdtempSync(join(tmpdir(), 'cequ-up-'));
const fx = {};
before(() => {
  writeFileSync(join(dir, 'small.png'), png(40, 30));
  writeFileSync(join(dir, 'big.png'), png(300, 200));
  if (MAC) execFileSync('sips', ['-s', 'format', 'jpeg', '-z', '2000', '3000', join(dir, 'big.png'), '--out', join(dir, 'big.jpg')], { stdio: 'ignore' });
  else writeFileSync(join(dir, 'big.jpg'), jpegHeader(3000, 2000));
  for (const f of ['small.png', 'big.jpg']) fx[f] = readFileSync(join(dir, f));
  if (MAC) try {
    execFileSync('sips', ['-s', 'format', 'heic', join(dir, 'big.png'), '--out', join(dir, 'p.heic')], { stdio: 'ignore' });
    fx.heic = readFileSync(join(dir, 'p.heic'));
  } catch { /* no HEIC encoder on this Mac: that test is skipped */ }
});

test('sniff recognises formats by magic bytes, not names', () => {
  assert.equal(sniff(fx['small.png']), 'png');
  assert.equal(sniff(fx['big.jpg']), 'jpg');
  assert.equal(sniff(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
  assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
});

test('PNG stays PNG and is not upscaled', async () => {
  const r = await processUpload(fx['small.png'], 'small.png', out);
  assert.equal(r.width, 40); assert.equal(r.height, 30);
  assert.match(r.name, /^[a-f0-9]{12}\.png$/);
  assert.ok(existsSync(r.file));
});

test('photo sizes are read from the file header', () => {
  assert.deepEqual(imageSize(fx['small.png']), { width: 40, height: 30 });
  assert.deepEqual(imageSize(jpegHeader(3000, 2000)), { width: 3000, height: 2000 });
});

test('large JPEG is resized so the longest side is 1800', async (t) => {
  if (!MAC) return t.skip('resizing needs macOS sips or ImageMagick');
  const r = await processUpload(fx['big.jpg'], 'photo.jpg', out);
  assert.equal(Math.max(r.width, r.height), 1800);
  assert.match(r.name, /\.jpg$/);
});

test('HEIC becomes JPEG', async (t) => {
  if (!fx.heic) return t.skip('no HEIC encoder');
  const r = await processUpload(fx.heic, 'IMG_0001.HEIC', out);
  assert.match(r.name, /\.jpg$/);
  assert.equal(sniff(readFileSync(r.file)), 'jpg');
});

test('non-images are refused with 415, oversize with 413', async () => {
  await assert.rejects(processUpload(Buffer.from('hello'), 'fake.jpg', out), e => e.status === 415);
  const huge = Buffer.concat([fx['big.jpg'], Buffer.alloc(26 * 1024 * 1024)]);
  await assert.rejects(processUpload(huge, 'huge.jpg', out), e => e.status === 413);
});
