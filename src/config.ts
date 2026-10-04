/**
 * Configuración del servidor MCP para GECOR / Chiclana
 */
import os from "node:os";
import path from "node:path";

export const GECOR_API_URL = process.env.GECOR_API_URL || "https://gecorapiwe.azurewebsites.net/api";
export const GECOR_INFO_URL = process.env.GECOR_INFO_URL || "https://infogecorwe.azurewebsites.net/api";
export const GECOR_BLOB_URL = process.env.GECOR_BLOB_URL || "https://gecorsystem.blob.core.windows.net/public/";

// Por defecto Chiclana de la Frontera (AyuntamientoID: 268)
export const DEFAULT_AYTO_ID = Number(process.env.GECOR_AYTO_ID || "268");
export const DEFAULT_AYTO_NAME = process.env.GECOR_AYTO_NAME || "Chiclana de la Frontera";

// Procedencias Web y Móvil para Chiclana por defecto
export const DEFAULT_PROCEDENCIA_WEB = Number(process.env.GECOR_PROCEDENCIA_WEB || "1390");
export const DEFAULT_PROCEDENCIA_MOVIL = Number(process.env.GECOR_PROCEDENCIA_MOVIL || "1391");

// Sole authentication source: environment of this MCP server process.
export const GECOR_TOKEN = process.env.GECOR_TOKEN || "";

export const DEFAULT_LANGUAGE = process.env.GECOR_LANGUAGE || "es";

// Fotos: se leen por llamada para que los cambios de entorno surtan efecto sin reiniciar.
export const DEFAULT_MAX_PHOTO_BYTES = 20 * 1024 * 1024;

export function getMaxPhotoBytes(): number {
  const parsed = Number(process.env.GECOR_MAX_PHOTO_BYTES || DEFAULT_MAX_PHOTO_BYTES);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PHOTO_BYTES;
}

// Directorios permitidos para image_path. GECOR_PHOTO_DIRS (separado por path.delimiter) sustituye a los valores por defecto.
export function getPhotoDirs(): string[] {
  const configured = process.env.GECOR_PHOTO_DIRS;
  if (configured !== undefined && configured.trim()) {
    return configured.split(path.delimiter).map((dir) => dir.trim()).filter((dir) => dir && path.isAbsolute(dir));
  }
  const home = os.homedir();
  return [os.tmpdir(), ...["Downloads", "Pictures", "Desktop", ".hermes"].map((dir) => path.join(home, dir))];
}
