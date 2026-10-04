/**
 * Configuración del servidor MCP para GECOR / Chiclana
 */
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

// Relativo a dist/config.js (o src/config.ts): package.json está en la raíz del paquete.
export const PACKAGE_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export const GECOR_API_URL = process.env.GECOR_API_URL || "https://gecorapiwe.azurewebsites.net/api";

// Por defecto Chiclana de la Frontera (AyuntamientoID: 268)
export const DEFAULT_AYTO_ID = Number(process.env.GECOR_AYTO_ID || "268");

// Procedencia Web de Chiclana; solo se usa si la ficha del ayuntamiento no trae ProcedenciaWeb.
export const DEFAULT_PROCEDENCIA_WEB = 1390;

export function getProcedenciaWeb(): number {
  const parsed = Number(process.env.GECOR_PROCEDENCIA_WEB || DEFAULT_PROCEDENCIA_WEB);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PROCEDENCIA_WEB;
}

// Sole authentication source: environment of this MCP server process.
export const GECOR_TOKEN = process.env.GECOR_TOKEN || "";

export const DEFAULT_LANGUAGE = process.env.GECOR_LANGUAGE || "es";

// Tiempo máximo por petición a GECOR; se lee por llamada como el resto de ajustes dinámicos.
export const DEFAULT_GECOR_TIMEOUT_MS = 20_000;
// Valores superiores se recortan a este máximo.
export const MAX_GECOR_TIMEOUT_MS = 120_000;

export function getGecorTimeoutMs(): number {
  const parsed = Number(process.env.GECOR_TIMEOUT_MS || DEFAULT_GECOR_TIMEOUT_MS);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_GECOR_TIMEOUT_MS;
  return Math.min(parsed, MAX_GECOR_TIMEOUT_MS);
}

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
