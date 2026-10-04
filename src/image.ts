/**
 * Reducción de fotos JPEG conservando los segmentos APP1 (Exif/XMP) originales
 */
import jpeg from "jpeg-js";

export const MAX_UPLOAD_SIDE = 2048;
const JPEG_QUALITY = 85;
const MAX_DECODE_MP = 100;
const MAX_DECODE_MEMORY_MB = 512;
const MAX_APP1_PAYLOAD = 65533;

export interface ImageSize {
  width: number;
  height: number;
}

export interface ReducedJpeg {
  buffer: Buffer;
  reduced: boolean;
  exifPreserved: boolean;
  width?: number;
  height?: number;
}

interface JpegSegment {
  marker: number;
  start: number;
  end: number;
}

/** Recorre los segmentos de cabecera hasta SOS/EOI; se detiene ante datos mal formados */
function jpegSegments(buf: Buffer): JpegSegment[] {
  const segments: JpegSegment[] = [];
  let off = 2;
  while (off + 1 < buf.length) {
    if (buf[off] !== 0xff) break;
    let markerAt = off + 1;
    while (markerAt < buf.length && buf[markerAt] === 0xff) markerAt++;
    if (markerAt >= buf.length) break;
    const marker = buf[markerAt];
    off = markerAt + 1;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda || off + 2 > buf.length) break;
    const len = buf.readUInt16BE(off);
    if (len < 2 || off + len > buf.length) break;
    segments.push({ marker, start: markerAt - 1, end: off + len });
    off += len;
  }
  return segments;
}

function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** Dimensiones según el primer marcador SOF, sin decodificar píxeles */
export function readJpegSize(buf: Buffer): ImageSize | null {
  for (const seg of jpegSegments(buf)) {
    if (!isSofMarker(seg.marker) || seg.end - seg.start < 9) continue;
    const height = buf.readUInt16BE(seg.start + 5);
    const width = buf.readUInt16BE(seg.start + 7);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

/** Dimensiones de la cabecera IHDR de un PNG */
export function readPngSize(buf: Buffer): ImageSize | null {
  if (buf.length < 24 || buf.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Segmentos APP1 completos (marcador incluido) en su orden original */
export function extractApp1Segments(buf: Buffer): Buffer[] {
  return jpegSegments(buf)
    .filter((seg) => seg.marker === 0xe1 && seg.end - seg.start - 4 <= MAX_APP1_PAYLOAD)
    .map((seg) => buf.subarray(seg.start, seg.end));
}

/** Pesos de reducción por promedio de área: cada destino cubre `scale` píxeles de origen */
function areaWeights(srcLen: number, dstLen: number): { index: Int32Array; weight: Float32Array; offsets: Int32Array } {
  const scale = srcLen / dstLen;
  const index: number[] = [];
  const weight: number[] = [];
  const offsets = new Int32Array(dstLen + 1);
  for (let d = 0; d < dstLen; d++) {
    offsets[d] = index.length;
    const from = d * scale;
    const to = Math.min(srcLen, (d + 1) * scale);
    for (let s = Math.floor(from); s < to; s++) {
      const overlap = Math.min(s + 1, to) - Math.max(s, from);
      if (overlap <= 0) continue;
      index.push(s);
      weight.push(overlap / scale);
    }
  }
  offsets[dstLen] = index.length;
  return { index: Int32Array.from(index), weight: Float32Array.from(weight), offsets };
}

/** Reduce RGB (3 canales) a RGBA por promedio de área, procesando una fila de origen cada vez */
function downscaleRgb(src: Uint8Array, srcW: number, srcH: number, dstW: number, dstH: number): Buffer {
  const cols = areaWeights(srcW, dstW);
  const rowScale = srcH / dstH;
  const acc = new Float32Array(dstW * dstH * 3);
  const row = new Float32Array(dstW * 3);
  for (let y = 0; y < srcH; y++) {
    const base = y * srcW * 3;
    for (let x = 0; x < dstW; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = cols.offsets[x]; k < cols.offsets[x + 1]; k++) {
        const p = base + cols.index[k] * 3;
        const w = cols.weight[k];
        r += src[p] * w;
        g += src[p + 1] * w;
        b += src[p + 2] * w;
      }
      row[x * 3] = r;
      row[x * 3 + 1] = g;
      row[x * 3 + 2] = b;
    }
    // Una fila de origen solapa como mucho dos filas de destino al reducir.
    const first = Math.floor(y / rowScale);
    const last = Math.min(dstH - 1, Math.floor((y + 1) / rowScale - 1e-9));
    for (let d = first; d <= last; d++) {
      const overlap = Math.min(y + 1, (d + 1) * rowScale) - Math.max(y, d * rowScale);
      if (overlap <= 0) continue;
      const w = overlap / rowScale;
      const out = d * dstW * 3;
      for (let i = 0; i < row.length; i++) acc[out + i] += row[i] * w;
    }
  }
  const rgba = Buffer.alloc(dstW * dstH * 4);
  for (let p = 0, q = 0; p < acc.length; p += 3, q += 4) {
    rgba[q] = Math.min(255, Math.round(acc[p]));
    rgba[q + 1] = Math.min(255, Math.round(acc[p + 1]));
    rgba[q + 2] = Math.min(255, Math.round(acc[p + 2]));
    rgba[q + 3] = 255;
  }
  return rgba;
}

/**
 * Reduce un JPEG cuyo lado mayor supere MAX_UPLOAD_SIDE. No rota píxeles: los APP1
 * originales (incluida Orientation) se insertan tras SOI y siguen siendo válidos.
 */
export function reduceJpeg(buf: Buffer): ReducedJpeg {
  const app1 = extractApp1Segments(buf);
  const size = readJpegSize(buf);
  const original: ReducedJpeg = { buffer: buf, reduced: false, exifPreserved: app1.length > 0, ...size };
  if (!size || Math.max(size.width, size.height) <= MAX_UPLOAD_SIDE) return original;

  let decoded: { width: number; height: number; data: Uint8Array };
  try {
    decoded = jpeg.decode(buf, {
      useTArray: true,
      formatAsRGBA: false,
      maxResolutionInMP: MAX_DECODE_MP,
      maxMemoryUsageInMB: MAX_DECODE_MEMORY_MB,
    });
  } catch (err: any) {
    throw new Error(`No se pudo reducir la foto JPEG: no se pudo decodificar (${err?.message || String(err)}). Prueba con otra foto o una de menor resolución.`);
  }
  const { width, height } = decoded;
  if (decoded.data.length < width * height * 3) {
    throw new Error("No se pudo reducir la foto JPEG: datos de imagen incompletos.");
  }
  const scale = Math.max(width, height) / MAX_UPLOAD_SIDE;
  const dstW = Math.max(1, Math.min(MAX_UPLOAD_SIDE, Math.round(width / scale)));
  const dstH = Math.max(1, Math.min(MAX_UPLOAD_SIDE, Math.round(height / scale)));
  const rgba = downscaleRgb(decoded.data, width, height, dstW, dstH);
  const encoded = jpeg.encode({ width: dstW, height: dstH, data: rgba }, JPEG_QUALITY).data;
  const output = Buffer.concat([encoded.subarray(0, 2), ...app1, encoded.subarray(2)]);
  if (output.length >= buf.length) return original;
  return { buffer: output, reduced: true, exifPreserved: app1.length > 0, width: dstW, height: dstH };
}
