/**
 * Utilidades para análisis de fotos y extracción de coordenadas GPS EXIF
 */
import { constants as fsConstants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import exifParser from "exif-parser";
import { getMaxPhotoBytes, getPhotoDirs } from "./config.js";
import { readPngSize, reduceJpeg } from "./image.js";

export type PhotoMime = "image/jpeg" | "image/png";

export interface PhotoGps {
  lat: number;
  lng: number;
  alt?: number;
}

/** Miniatura para que el modelo vea la foto; nunca se sube ni lleva EXIF (salvo PNG tal cual) */
export interface PhotoThumbnail {
  mime: PhotoMime;
  base64: string;
  width: number;
  height: number;
}

export interface PhotoInfo {
  width?: number;
  height?: number;
  make?: string;
  model?: string;
  takenAt?: string;
  gps: PhotoGps | null;
  /** Tamaño de la foto recibida */
  bytes: number;
  /** Tamaño de la foto que se subirá (reducida si procede) */
  uploadBytes: number;
  reduced: boolean;
  exifPreserved: boolean;
  mime: PhotoMime;
  base64: string;
  dataUri: string;
  warning?: string;
  reductionWarning?: string;
  thumbnail?: PhotoThumbnail;
  /** Motivo por el que no hay miniatura. */
  thumbnailWarning?: string;
}

/** Los PNG no se decodifican: se devuelven tal cual como miniatura si no superan este tamaño. */
export const MAX_PNG_THUMBNAIL_BYTES = 1024 * 1024;

const UNSUPPORTED_FORMAT = "Formato no soportado: usa JPEG o PNG.";
const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function tooLarge(maxBytes: number): Error {
  return new Error(`La foto es demasiado grande (máximo ${maxBytes} bytes, ajustable con GECOR_MAX_PHOTO_BYTES).`);
}

/** Detecta el tipo por la firma de bytes; solo se aceptan JPEG y PNG */
export function detectPhotoMime(buf: Buffer): PhotoMime | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => buf[i] === b)) return "image/png";
  return null;
}

function decodeBase64(imageBase64: string, maxBytes: number): Buffer {
  // Cota previa barata: evita procesar cadenas enormes antes de limpiar espacios.
  if (imageBase64.length > Math.ceil(maxBytes / 3) * 4 * 2 + 1024) throw tooLarge(maxBytes);
  const prefix = /^\s*data:image\/[\w+.-]+;base64,/.exec(imageBase64);
  const body = (prefix ? imageBase64.slice(prefix[0].length) : imageBase64).replace(/\s+/g, "");
  if (!body || !BASE64_BODY.test(body) || body.length % 4 === 1) {
    throw new Error("image_base64 está vacío o no es base64 válido.");
  }
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  if (Math.floor((body.length * 3) / 4) - padding > maxBytes) throw tooLarge(maxBytes);
  return Buffer.from(body, "base64");
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function allowedPhotoRoots(): Promise<string[]> {
  const roots: string[] = [];
  for (const dir of getPhotoDirs()) {
    try {
      roots.push(await realpath(dir));
    } catch {
      // Los directorios inexistentes no se permiten.
    }
  }
  return roots;
}

async function readConfinedFile(imagePath: string, maxBytes: number): Promise<Buffer> {
  let real: string;
  try {
    real = await realpath(imagePath);
  } catch {
    throw new Error("No se encontró la foto en image_path.");
  }
  const roots = await allowedPhotoRoots();
  if (!roots.some((root) => isInside(root, real))) {
    throw new Error("image_path está fuera de los directorios permitidos para fotos. Configura GECOR_PHOTO_DIRS o usa image_base64.");
  }
  // Abrir una FIFO o un dispositivo puede bloquear indefinidamente: se descartan antes de open().
  const notRegular = () => new Error("image_path debe apuntar a un fichero regular.");
  const before = await stat(real);
  if (!before.isFile()) throw notRegular();
  if (before.size > maxBytes) throw tooLarge(maxBytes);
  const handle = await open(real, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw notRegular();
    if (opened.size > maxBytes) throw tooLarge(maxBytes);
    const buf = await handle.readFile();
    if (buf.length > maxBytes) throw tooLarge(maxBytes);
    return buf;
  } finally {
    await handle.close();
  }
}

/** Carga el buffer de la foto desde base64 o fichero local */
export async function loadPhotoBuffer(imageBase64?: string, imagePath?: string): Promise<Buffer> {
  if (imageBase64 && imagePath) {
    throw new Error("Pasa solo una opción: image_base64 o image_path.");
  }
  const maxBytes = getMaxPhotoBytes();
  if (imageBase64) return decodeBase64(imageBase64, maxBytes);
  if (imagePath) return readConfinedFile(imagePath, maxBytes);
  throw new Error("Falta la imagen: proporciona image_base64 o image_path.");
}

function toDecimal(val: unknown, ref: unknown, negativeRef: string): number | null {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (Array.isArray(val) && val.length >= 2) {
    const [d = 0, m = 0, s = 0] = val.map(Number);
    if ([d, m, s].some((n) => !Number.isFinite(n))) return null;
    let dec = Math.abs(d) + Math.abs(m) / 60 + Math.abs(s) / 3600;
    if (String(ref ?? "").toUpperCase() === negativeRef) dec = -dec;
    return dec;
  }
  return null;
}

function inRange(n: number | null, min: number, max: number): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
}

/** Orientation EXIF (1-8); 1 si no hay EXIF legible */
function readOrientation(buf: Buffer): number {
  try {
    const orientation = exifParser.create(buf).parse().tags.Orientation;
    return typeof orientation === "number" ? orientation : 1;
  } catch {
    return 1;
  }
}

/**
 * Extrae metadatos y coordenadas GPS EXIF de una imagen
 */
export async function parsePhoto(imageBase64?: string, imagePath?: string): Promise<PhotoInfo> {
  const buf = await loadPhotoBuffer(imageBase64, imagePath);
  const mime = detectPhotoMime(buf);
  if (!mime) throw new Error(UNSUPPORTED_FORMAT);
  // Solo se reducen JPEG; el EXIF se lee siempre del buffer original.
  const upload = mime === "image/jpeg"
    ? reduceJpeg(buf, readOrientation(buf))
    : { buffer: buf, reduced: false, exifPreserved: false, ...readPngSize(buf) };
  const base64 = upload.buffer.toString("base64");
  const info: PhotoInfo = {
    gps: null,
    bytes: buf.length,
    uploadBytes: upload.buffer.length,
    reduced: upload.reduced,
    exifPreserved: upload.exifPreserved,
    mime,
    base64,
    dataUri: `data:${mime};base64,${base64}`,
  };
  if ("warning" in upload && upload.warning) info.reductionWarning = upload.warning;
  if (upload.width && upload.height) {
    info.width = upload.width;
    info.height = upload.height;
  }
  if ("thumbnail" in upload && upload.thumbnail) {
    const { buffer, width, height } = upload.thumbnail;
    info.thumbnail = { mime: "image/jpeg", base64: buffer.toString("base64"), width, height };
  } else if ("thumbnailWarning" in upload && upload.thumbnailWarning) {
    info.thumbnailWarning = upload.thumbnailWarning;
  } else if (mime === "image/png") {
    if (buf.length > MAX_PNG_THUMBNAIL_BYTES) {
      info.thumbnailWarning = `El PNG supera ${MAX_PNG_THUMBNAIL_BYTES} bytes: no se genera miniatura.`;
    } else if (info.width && info.height) {
      info.thumbnail = { mime, base64, width: info.width, height: info.height };
    } else {
      info.thumbnailWarning = "No se pudieron leer las dimensiones del PNG: no se genera miniatura.";
    }
  }

  if (mime !== "image/jpeg") {
    info.warning = "La imagen no es JPEG: no se pueden leer etiquetas EXIF automáticamente. Pasa las coordenadas lat/lng manualmente.";
    return info;
  }

  try {
    const parser = exifParser.create(buf);
    const r = parser.parse();
    const tags = r.tags;

    if (r.imageSize && info.width === undefined) {
      info.width = r.imageSize.width;
      info.height = r.imageSize.height;
    }
    if (typeof tags.Make === "string") info.make = tags.Make;
    if (typeof tags.Model === "string") info.model = tags.Model;

    const ts = tags.DateTimeOriginal ?? tags.CreateDate;
    if (typeof ts === "number" && Number.isFinite(ts)) {
      info.takenAt = new Date(ts * 1000).toISOString();
    }

    const lat = toDecimal(tags.GPSLatitude, tags.GPSLatitudeRef, "S");
    const lng = toDecimal(tags.GPSLongitude, tags.GPSLongitudeRef, "W");

    if (inRange(lat, -90, 90) && inRange(lng, -180, 180)) {
      info.gps = {
        lat,
        lng,
        alt: typeof tags.GPSAltitude === "number" ? tags.GPSAltitude : undefined,
      };
    } else if (tags.GPSLatitude !== undefined || tags.GPSLongitude !== undefined) {
      info.warning = "El EXIF contiene coordenadas GPS fuera de rango válido.";
    }
  } catch {
    info.warning = "No se pudieron decodificar los metadatos EXIF. Pasa las coordenadas manualmente.";
  }

  return info;
}
