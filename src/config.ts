/**
 * Configuración del servidor MCP para GECOR / Chiclana
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const GECOR_API_URL = process.env.GECOR_API_URL || "https://gecorapiwe.azurewebsites.net/api";
export const GECOR_INFO_URL = process.env.GECOR_INFO_URL || "https://infogecorwe.azurewebsites.net/api";
export const GECOR_BLOB_URL = process.env.GECOR_BLOB_URL || "https://gecorsystem.blob.core.windows.net/public/";

// Por defecto Chiclana de la Frontera (AyuntamientoID: 268)
export const DEFAULT_AYTO_ID = Number(process.env.GECOR_AYTO_ID || "268");
export const DEFAULT_AYTO_NAME = process.env.GECOR_AYTO_NAME || "Chiclana de la Frontera";

// Procedencias Web y Móvil para Chiclana por defecto
export const DEFAULT_PROCEDENCIA_WEB = Number(process.env.GECOR_PROCEDENCIA_WEB || "1390");
export const DEFAULT_PROCEDENCIA_MOVIL = Number(process.env.GECOR_PROCEDENCIA_MOVIL || "1391");

// Credenciales opcionales por entorno
export const GECOR_TOKEN = process.env.GECOR_TOKEN || "";
export const GECOR_EMAIL = process.env.GECOR_EMAIL || "";
export const GECOR_PASSWORD = process.env.GECOR_PASSWORD || "";

// Almacén persistente de sesión por defecto ~/.gecor-session.json
export const DEFAULT_TOKEN_STORE_PATH =
  process.env.GECOR_TOKEN_STORE || join(homedir(), ".gecor-session.json");

export const DEFAULT_LANGUAGE = process.env.GECOR_LANGUAGE || "es";
