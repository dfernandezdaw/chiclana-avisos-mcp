/**
 * Utilidades para análisis de fotos y extracción de coordenadas GPS EXIF
 */
import { readFile } from "node:fs/promises";
import exifParser from "exif-parser";

export interface PhotoGps {
  lat: number;
  lng: number;
  alt?: number;
}

export interface PhotoInfo {
  width?: number;
  height?: number;
  make?: string;
  model?: string;
  takenAt?: string;
  gps: PhotoGps | null;
  bytes: number;
  base64: string;
  warning?: string;
}

/** Carga el buffer de la foto desde base64 o fichero local */
export async function loadPhotoBuffer(imageBase64?: string, imagePath?: string): Promise<Buffer> {
  if (imageBase64 && imagePath) {
    throw new Error("Pasa solo una opción: image_base64 o image_path.");
  }
  if (imageBase64) {
    const clean = imageBase64.replace(/^data:image\/[\w+.-]+;base64,/, "").trim();
    const buf = Buffer.from(clean, "base64");
    if (!buf.length) throw new Error("image_base64 está vacío o no es válido.");
    return buf;
  }
  if (imagePath) {
    return readFile(imagePath);
  }
  throw new Error("Falta la imagen: proporciona image_base64 o image_path.");
}

function isJpeg(buf: Buffer): boolean {
  return buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8;
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

/**
 * Extrae metadatos y coordenadas GPS EXIF de una imagen
 */
export async function parsePhoto(imageBase64?: string, imagePath?: string): Promise<PhotoInfo> {
  const buf = await loadPhotoBuffer(imageBase64, imagePath);
  const base64 = buf.toString("base64");
  const info: PhotoInfo = {
    gps: null,
    bytes: buf.length,
    base64,
  };

  if (!isJpeg(buf)) {
    info.warning = "La imagen no es JPEG: no se pueden leer etiquetas EXIF automáticamente. Pasa las coordenadas lat/lng manualmente.";
    return info;
  }

  try {
    const parser = exifParser.create(buf);
    const r = parser.parse();
    const tags = r.tags;

    if (r.imageSize) {
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
