/**
 * Reducción de fotos JPEG conservando los segmentos APP1 (Exif/XMP) originales
 * y miniatura sin metadatos para que el modelo vea la foto
 */
import jpeg from "jpeg-js";

export const MAX_UPLOAD_SIDE = 2048;
export const MAX_THUMBNAIL_SIDE = 1024;
const JPEG_QUALITY = 85;
const THUMBNAIL_QUALITY = 80;
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
  /** Motivo por el que se sube el original sin reducir, si la reducción falló. */
  warning?: string;
  /** JPEG ≤ MAX_THUMBNAIL_SIDE sin APP1, con la orientación EXIF ya aplicada a los píxeles. */
  thumbnail?: JpegThumbnail;
  /** Motivo por el que no hay miniatura. */
  thumbnailWarning?: string;
}

export interface JpegThumbnail {
  buffer: Buffer;
  width: number;
  height: number;
}

interface DecodedRgb {
  width: number;
  height: number;
  data: Uint8Array;
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

/** Dimensiones que caben en `max` px de lado mayor conservando la proporción */
function fitWithin(width: number, height: number, max: number): ImageSize {
  if (Math.max(width, height) <= max) return { width, height };
  const scale = Math.max(width, height) / max;
  return {
    width: Math.max(1, Math.min(max, Math.round(width / scale))),
    height: Math.max(1, Math.min(max, Math.round(height / scale))),
  };
}

/** Aplica la orientación EXIF (1-8) a píxeles RGBA; 5-8 intercambian ancho y alto */
function orientRgba(src: Buffer, w: number, h: number, orientation: number): { data: Buffer; width: number; height: number } {
  if (!Number.isInteger(orientation) || orientation < 2 || orientation > 8) return { data: src, width: w, height: h };
  const swap = orientation >= 5;
  const outW = swap ? h : w;
  const out = Buffer.alloc(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx = x, dy = y;
      switch (orientation) {
        case 2: dx = w - 1 - x; break;
        case 3: dx = w - 1 - x; dy = h - 1 - y; break;
        case 4: dy = h - 1 - y; break;
        case 5: dx = y; dy = x; break;
        case 6: dx = h - 1 - y; dy = x; break;
        case 7: dx = h - 1 - y; dy = w - 1 - x; break;
        case 8: dx = y; dy = w - 1 - x; break;
      }
      src.copy(out, (dy * outW + dx) * 4, (y * w + x) * 4, (y * w + x) * 4 + 4);
    }
  }
  return { data: out, width: outW, height: swap ? w : h };
}

/** Miniatura JPEG sin segmentos APP1: jpeg-js solo escribe APP0/JFIF al codificar */
function encodeThumbnail(decoded: DecodedRgb, orientation: number): JpegThumbnail {
  const size = fitWithin(decoded.width, decoded.height, MAX_THUMBNAIL_SIDE);
  const rgba = downscaleRgb(decoded.data, decoded.width, decoded.height, size.width, size.height);
  const oriented = orientRgba(rgba, size.width, size.height, orientation);
  const buffer = Buffer.from(jpeg.encode(oriented, THUMBNAIL_QUALITY).data);
  return { buffer, width: oriented.width, height: oriented.height };
}

/**
 * Reduce un JPEG cuyo lado mayor supere MAX_UPLOAD_SIDE. No rota píxeles: los APP1
 * originales (incluida Orientation) se insertan tras SOI y siguen siendo válidos.
 * Con los mismos píxeles decodificados genera la miniatura para el modelo, que sí
 * se rota según `orientation` porque no lleva EXIF.
 */
export function reduceJpeg(buf: Buffer, orientation = 1): ReducedJpeg {
  const app1 = extractApp1Segments(buf);
  const size = readJpegSize(buf);
  const original: ReducedJpeg = { buffer: buf, reduced: false, exifPreserved: app1.length > 0, ...size };
  const needsReduction = size !== null && Math.max(size.width, size.height) > MAX_UPLOAD_SIDE;
  const failed = (reason: string): ReducedJpeg => ({
    ...original,
    // Una foto válida que jpeg-js no sabe decodificar no debe bloquear el aviso: se sube el original.
    ...(needsReduction ? { warning: `No se pudo reducir la foto JPEG (${reason}); se subirá sin reducir.` } : {}),
    thumbnailWarning: `No se pudo generar la miniatura (${reason}).`,
  });

  let decoded: DecodedRgb;
  try {
    decoded = jpeg.decode(buf, {
      useTArray: true,
      formatAsRGBA: false,
      maxResolutionInMP: MAX_DECODE_MP,
      maxMemoryUsageInMB: MAX_DECODE_MEMORY_MB,
    });
  } catch (err: any) {
    return failed(err?.message || String(err));
  }
  const { width, height } = decoded;
  if (decoded.data.length < width * height * 3) return failed("datos de imagen incompletos");

  const withThumbnail: ReducedJpeg = { ...original };
  try {
    withThumbnail.thumbnail = encodeThumbnail(decoded, orientation);
  } catch (err: any) {
    withThumbnail.thumbnailWarning = `No se pudo generar la miniatura (${err?.message || String(err)}).`;
  }
  if (!needsReduction) return withThumbnail;

  const dst = fitWithin(width, height, MAX_UPLOAD_SIDE);
  const rgba = downscaleRgb(decoded.data, width, height, dst.width, dst.height);
  const encoded = jpeg.encode({ width: dst.width, height: dst.height, data: rgba }, JPEG_QUALITY).data;
  const output = Buffer.concat([encoded.subarray(0, 2), ...app1, encoded.subarray(2)]);
  if (output.length >= buf.length) return withThumbnail;
  return { ...withThumbnail, buffer: output, reduced: true, width: dst.width, height: dst.height };
}
