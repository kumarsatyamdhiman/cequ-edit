// Upload processing: accept real photos only and normalise them for the web.
// macOS uses the built-in `sips`; elsewhere ImageMagick (`magick`) when installed; without either, JPG/PNG/WebP
// are kept exactly as uploaded and HEIC is refused with a clear message.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { IS_MAC } from './platform.mjs';

const run = promisify(execFile);
export const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_SIDE = 1800;
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

// Identify the format from the file's first bytes; anything else (incl. SVG) is refused.
export function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('latin1', 4, 8) === 'ftyp' && HEIC_BRANDS.has(buf.toString('latin1', 8, 12))) return 'heic';
  return null;
}

const fail = (status, message) => Object.assign(new Error(message), { status });

// Pixel size read from the file header (no image tool needed).
export function imageSize(buf) {
  const kind = sniff(buf);
  if (kind === 'png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (kind === 'webp') {
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
    if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  if (kind === 'jpg') {
    for (let i = 2; i + 9 < buf.length;) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

let magick;
const hasMagick = async () => (magick ??= await run('magick', ['-version'], { windowsHide: true }).then(() => true, () => false));
// ponytail: ImageMagick 6 on Linux ships `convert`, not `magick`; those systems keep photos as uploaded.

async function dimensions(file) {
  const { stdout } = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
  const num = key => Number(new RegExp(`${key}: (\\d+)`).exec(stdout)?.[1]);
  return { width: num('pixelWidth'), height: num('pixelHeight') };
}

// Returns { uploadId, name, file, width, height }. PNG stays PNG (may need transparency); the rest become JPEG.
export async function processUpload(buf, originalName, dir) {
  if (buf.length > MAX_BYTES) throw fail(413, `"${originalName}" is larger than 25 MB.`);
  const kind = sniff(buf);
  if (!kind) throw fail(415, `"${originalName}" is not a JPG, PNG, WEBP or HEIC photo.`);

  const uploadId = randomBytes(6).toString('hex');
  const ext = kind === 'png' ? 'png' : 'jpg';
  const src = join(dir, `${uploadId}-source.${kind}`);
  const name = `${uploadId}.${ext}`;
  const file = join(dir, name);
  await writeFile(src, buf);
  try {
    if (!IS_MAC && await hasMagick()) {
      await run('magick', [src, '-auto-orient', '-resize', `${MAX_SIDE}x${MAX_SIDE}>`, ...(ext === 'jpg' ? ['-quality', '84'] : []), file], { windowsHide: true });
      return { uploadId, name, file, ...imageSize(await readFile(file)) };
    }
    if (!IS_MAC) {                                     // no image tool: keep the photo exactly as uploaded
      if (kind === 'heic') throw fail(415, `"${originalName}" is an iPhone HEIC photo, which this computer cannot convert. Save it as JPG or PNG (or install ImageMagick) and try again.`);
      const keep = `${uploadId}.${kind}`;
      await writeFile(join(dir, keep), buf);
      return { uploadId, name: keep, file: join(dir, keep), ...imageSize(buf) };
    }
    const { width, height } = await dimensions(src);
    const args = ['-s', 'format', ext === 'png' ? 'png' : 'jpeg'];
    if (ext === 'jpg') args.push('-s', 'formatOptions', '84');
    if (Math.max(width, height) > MAX_SIDE) args.push('-Z', String(MAX_SIDE));   // never upscale
    await run('sips', [...args, src, '--out', file]);
    return { uploadId, name, file, ...(await dimensions(file)) };
  } catch (e) {
    if (e.status) throw e;
    throw fail(415, `"${originalName}" could not be converted (${e.message.split('\n')[0]}).`);
  } finally {
    await rm(src, { force: true });
  }
}
