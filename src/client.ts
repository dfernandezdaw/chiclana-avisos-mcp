/**
 * Cliente de conexión directa a la API REST de GECOR
 */
import {
  GECOR_API_URL,
  DEFAULT_AYTO_ID,
  DEFAULT_LANGUAGE,
  GECOR_TOKEN,
  getGecorTimeoutMs,
  getProcedenciaWeb,
} from "./config.js";
import type {
  GecorAyuntamiento,
  GecorTipologiaResponse,
  GecorCalle,
  GecorEdificio,
  GecorFotoUploadResponse,
  GecorAvisoItem,
  NuevaIncidenciaInput,
} from "./types.js";

export interface GecorClientOptions {
  ayuntamientoID?: number;
  language?: string;
  baseUrl?: string;
}

export type GecorErrorKind = "http" | "timeout" | "network";

export interface GecorApiErrorOptions {
  kind?: GecorErrorKind;
  timeoutMs?: number;
  // Valores que nunca deben aparecer en el texto del error (token, campos de la petición).
  secrets?: string[];
}

const MAX_ERROR_SNIPPET = 300;
const MIN_REDACTED_LENGTH = 8;
const JWT_PATTERN = /eyJ[\w-]+\.[\w-]+\.[\w-]*/g;

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}

// Formas en que un valor puede aparecer en una respuesta JSON: literal, escapado por JSON.stringify,
// con "/" como "\/" y con los caracteres no ASCII como \uXXXX (hex en minúsculas o mayúsculas).
function secretVariants(secret: string): string[] {
  const escaped = JSON.stringify(secret).slice(1, -1);
  const toUnicode = (s: string, upper: boolean) => s.replace(/[\u007f-\uffff]/g, (c) => {
    const hex = c.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${upper ? hex.toUpperCase() : hex}`;
  });
  const forms = [secret];
  for (const base of [escaped, toUnicode(escaped, false), toUnicode(escaped, true)]) {
    forms.push(base, base.replace(/\//g, "\\/"));
  }
  return [...new Set(forms)];
}

function sanitizeErrorSnippet(body: unknown, secrets: string[]): string {
  let text = typeof body === "string" ? body : body === undefined ? "" : JSON.stringify(body) ?? "";
  const variants = secrets.filter(Boolean).flatMap(secretVariants);
  for (const secret of [...new Set(variants)].sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("[redactado]");
  }
  text = text.replace(JWT_PATTERN, "[redactado]").replace(/(?:\\[nrt]|\s)+/g, " ").trim();
  return text.length > MAX_ERROR_SNIPPET ? `${text.slice(0, MAX_ERROR_SNIPPET - 1)}…` : text;
}

function formatGecorErrorMessage(status: number, endpoint: string, kind: GecorErrorKind, snippet: string, timeoutMs = 0): string {
  if (kind === "timeout") return `GECOR no respondió en ${timeoutMs / 1000} s (${endpoint}).`;
  if (kind === "network") return `No se pudo conectar con GECOR (${endpoint}).`;
  return `GECOR API error (${status}) en ${endpoint}${snippet ? `: ${snippet}` : ""}`;
}

export class GecorApiError extends Error {
  public kind: GecorErrorKind;
  // Fragmento saneado de la respuesta; nunca contiene la petición ni el token.
  public body: string;

  constructor(
    public status: number,
    public endpoint: string,
    body: unknown,
    opts: GecorApiErrorOptions = {},
  ) {
    const kind = opts.kind ?? "http";
    const snippet = sanitizeErrorSnippet(body, opts.secrets ?? []);
    super(formatGecorErrorMessage(status, endpoint, kind, snippet, opts.timeoutMs));
    this.name = "GecorApiError";
    this.kind = kind;
    this.body = snippet;
  }
}

// Solo las consultas (get*) son idempotentes; las escrituras nunca se reintentan.
function isRetryableEndpoint(endpoint: string): boolean {
  return /^get/i.test(endpoint.split("/").at(-1) ?? "");
}

function isTransientError(err: unknown): boolean {
  return err instanceof GecorApiError && (err.kind !== "http" || err.status >= 500);
}

export interface PetitionerIdentity {
  Nombre: string;
  Email: string;
  Movil: string;
  CiudadanoID: number;
}

export function extractPetitionerIdentity(token: string): PetitionerIdentity {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) throw new Error();
    const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw new Error();
    const source = claims as Record<string, unknown>;
    const values = new Map<string, unknown>();
    for (const [key, value] of Object.entries(source)) {
      const normalized = key.toLowerCase();
      if (["nombre", "email", "movil", "ciudadanoid"].includes(normalized)) values.set(normalized, value);
    }
    const nombre = values.get("nombre");
    const email = values.get("email");
    const movil = values.get("movil");
    const ciudadanoID = values.get("ciudadanoid");
    if (typeof nombre !== "string" || !nombre.trim() || typeof email !== "string" || !email.trim() ||
        typeof movil !== "string" || !movil.trim() || typeof ciudadanoID !== "number" ||
        !Number.isSafeInteger(ciudadanoID) || ciudadanoID <= 0) throw new Error();
    return { Nombre: nombre.trim(), Email: email.trim(), Movil: movil.trim(), CiudadanoID: ciudadanoID };
  } catch {
    throw new Error("No se pudo resolver la identidad del peticionario requerida desde GECOR_TOKEN.");
  }
}

export class GecorClient {
  private token: string;
  public ayuntamientoID: number;
  public language: string;
  private baseUrl: string;
  private currentAyuntamiento: GecorAyuntamiento | null = null;

  constructor(opts: GecorClientOptions = {}) {
    this.token = GECOR_TOKEN;
    this.ayuntamientoID = opts.ayuntamientoID ?? DEFAULT_AYTO_ID;
    this.language = opts.language ?? DEFAULT_LANGUAGE;
    this.baseUrl = opts.baseUrl ?? GECOR_API_URL;

  }

  hasToken(): boolean {
    return Boolean(this.token && this.token.trim().length > 0);
  }

  getToken(): string {
    return this.token;
  }

  getPetitionerIdentity(): PetitionerIdentity {
    return extractPetitionerIdentity(this.token);
  }

  private async post<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    try {
      return await this.request<T>(endpoint, body);
    } catch (err) {
      if (!isRetryableEndpoint(endpoint) || !isTransientError(err)) throw err;
      return this.request<T>(endpoint, body);
    }
  }

  private async request<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/${endpoint.replace(/^\//, "")}`;
    const timeoutMs = getGecorTimeoutMs();
    const secrets = [
      this.token,
      typeof body.token === "string" ? body.token : "",
      ...collectStrings(body).filter((value) => value.length >= MIN_REDACTED_LENGTH),
    ].filter(Boolean);
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (err: any) {
      if (err?.name === "TimeoutError") throw new GecorApiError(0, endpoint, undefined, { kind: "timeout", timeoutMs });
      throw new GecorApiError(0, endpoint, undefined, { kind: "network" });
    }

    if (!res.ok) {
      throw new GecorApiError(res.status, endpoint, text, { secrets });
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  /**
   * Obtiene la lista completa de municipios integrados en GECOR
   */
  async getAyuntamientos(language = this.language): Promise<GecorAyuntamiento[]> {
    return this.post<GecorAyuntamiento[]>("Utils/getAyuntamientos", { language });
  }

  /**
   * Obtiene la ficha del ayuntamiento activo
   */
  async getAyuntamiento(ayuntamientoID = this.ayuntamientoID): Promise<GecorAyuntamiento> {
    if (this.currentAyuntamiento && this.currentAyuntamiento.AyuntamientoID === ayuntamientoID) {
      return this.currentAyuntamiento;
    }
    const detail = await this.post<GecorAyuntamiento>("Utils/getAyuntamientoByAytoID", {
      language: this.language,
      ayuntamientoID,
    });
    this.currentAyuntamiento = detail;
    return detail;
  }

  /**
   * Comprueba el estado del token o intenta autenticarse si hay credenciales
   */
  async ensureAuthenticated(): Promise<string> {
    if (this.hasToken()) {
      return this.token;
    }
    throw new Error("Falta GECOR_TOKEN en el entorno del proceso MCP. Configúralo en la entrada MCP.");
  }

  /**
   * Obtiene el árbol completo de tipologías (Familias, Elementos/Subcategorías, Incidencias)
   */
  async getTipologia(ayuntamientoID = this.ayuntamientoID): Promise<GecorTipologiaResponse> {
    const token = await this.ensureAuthenticated();
    const res = await this.post<GecorTipologiaResponse>("Typology/getTipologiaPorAyuntamiento", {
      token,
      idioma: this.language,
    });

    if (res.Error && res.Error.Error) {
      throw new Error(`Error al obtener tipologías de GECOR: ${res.Error.Error}`);
    }

    return res;
  }

  /**
   * Obtiene el listado de calles del municipio
   */
  async getCalles(ayuntamientoID = this.ayuntamientoID): Promise<GecorCalle[]> {
    const token = await this.ensureAuthenticated();
    return this.post<GecorCalle[]>("Utils/getCallesPorAyuntamiento", { token });
  }

  /**
   * Obtiene calles georreferenciadas alrededor de unas coordenadas GPS
   */
  async getCallesGeorreferenciadas(lat: number, lng: number, radioMetros = 100): Promise<GecorCalle[]> {
    const token = await this.ensureAuthenticated();
    const convertToGps = (e: number) => 100 * Math.trunc(e) + 60 * (e - Math.trunc(e));
    const rad = Math.PI;
    const factor = 1 / ((2 * rad) / 360 * 6378.137) / 1000;
    const lat1 = lat + radioMetros * factor;
    const lat2 = lat - radioMetros * factor;
    const lng1 = lng + (radioMetros * factor) / Math.cos(lat * (rad / 180));
    const lng2 = lng - (radioMetros * factor) / Math.cos(lat * (rad / 180));

    return this.post<GecorCalle[]>("Utils/getCallesPorAyuntamientoGeoreferenciadas", {
      token,
      lat1: convertToGps(lat1),
      lat2: convertToGps(lat2),
      lng1: convertToGps(lng1),
      lng2: convertToGps(lng2),
    });
  }

  /**
   * Obtiene edificios públicos / dependencias del municipio
   */
  async getEdificios(ayuntamientoID = this.ayuntamientoID): Promise<GecorEdificio[]> {
    const token = await this.ensureAuthenticated();
    return this.post<GecorEdificio[]>("Utils/getEdificiosPorAyuntamiento", { token });
  }

  /**
   * Sube una foto codificada en base64 a GECOR y retorna la ruta en el servidor
   */
  async guardarFotoBase64(base64Image: string): Promise<string> {
    const token = await this.ensureAuthenticated();
    const res = await this.post<GecorFotoUploadResponse>("Incident/guardarFotoBase64", {
      token,
      byteFoto: base64Image,
    });
    if (!res || !res.rutaFoto) {
      throw new Error("No se pudo subir la foto a GECOR: respuesta inválida.");
    }
    return res.rutaFoto;
  }

  /**
   * Obtiene los avisos del usuario autenticado
   */
  async getMisIncidencias(): Promise<GecorAvisoItem[]> {
    const token = await this.ensureAuthenticated();
    return this.post<GecorAvisoItem[]>("Incident/getMisIncidencias", { token });
  }

  /**
   * Obtiene incidencias cercanas a unas coordenadas GPS
   */
  async getIncidenciasCercanas(lat: number, lng: number, radioMetros = 500): Promise<GecorAvisoItem[]> {
    const token = await this.ensureAuthenticated();
    const convertToGps = (e: number) => 100 * Math.trunc(e) + 60 * (e - Math.trunc(e));
    const rad = Math.PI;
    const factor = 1 / ((2 * rad) / 360 * 6378.137) / 1000;
    const lat1 = lat + radioMetros * factor;
    const lat2 = lat - radioMetros * factor;
    const lng1 = lng + (radioMetros * factor) / Math.cos(lat * (rad / 180));
    const lng2 = lng - (radioMetros * factor) / Math.cos(lat * (rad / 180));

    return this.post<GecorAvisoItem[]>("Incident/getIncidenciasCercanas", {
      token,
      lat1: convertToGps(lat1),
      lat2: convertToGps(lat2),
      lng1: convertToGps(lng1),
      lng2: convertToGps(lng2),
    });
  }

  /**
   * Registra una nueva incidencia en GECOR
   */
  async nuevaIncidencia(input: Omit<NuevaIncidenciaInput, "token" | "ayuntamientoID" | "tipoProcedenciaID" | "tipoIncID"> & {
    tipoIncID: number;
    ayuntamientoID?: number;
    tipoProcedenciaID?: number;
  }): Promise<Record<string, unknown>> {
    // El peticionario solo procede de la identidad del JWT; sin valores por defecto.
    if (!Number.isSafeInteger(input.ciudadanoID) || input.ciudadanoID <= 0 ||
        [input.nombrePeticionario, input.email, input.movil].some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error("Falta la identidad del peticionario (ciudadanoID, nombre, email y móvil) para registrar el aviso.");
    }
    const token = await this.ensureAuthenticated();
    const ayto = await this.getAyuntamiento(input.ayuntamientoID ?? this.ayuntamientoID);

    const payload: NuevaIncidenciaInput = {
      token,
      ayuntamientoID: ayto.AyuntamientoID,
      tipoProcedenciaID: input.tipoProcedenciaID ?? ayto.ProcedenciaWeb ?? getProcedenciaWeb(),
      ciudadanoID: input.ciudadanoID,
      nombrePeticionario: input.nombrePeticionario,
      email: input.email,
      movil: input.movil,
      tipoElementoID: input.tipoElementoID,
      desTipoElemento: input.desTipoElemento ?? "",
      tipoIncID: String(input.tipoIncID),
      tipoInc: input.tipoInc ?? "",
      desAveria: input.desAveria,
      x: input.x,
      y: input.y,
      calleID: input.calleID ?? 0,
      numCalle: input.numCalle ?? 0,
      desUbicacion: input.desUbicacion ?? "",
      edificioID: input.edificioID ?? 0,
      nombreEdificio: input.nombreEdificio ?? "",
      fotos: input.fotos ?? [],
      tokenAyto: ayto.TokenAyuntamiento ?? null,
      estadoAvisoID: -1,
      uni_cod: "",
      uni_direc: "",
      pro_cod: "",
      pro_nomb: "",
    };

    const res = await this.post<any>("Incident/nuevaIncidencia", payload as unknown as Record<string, unknown>);
    return Array.isArray(res) ? res[0] : res;
  }
}
