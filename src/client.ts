/**
 * Cliente de conexión directa a la API REST de GECOR
 */
import {
  GECOR_API_URL,
  DEFAULT_AYTO_ID,
  DEFAULT_LANGUAGE,
  GECOR_TOKEN,
} from "./config.js";
import type {
  GecorAyuntamiento,
  GecorUser,
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

export class GecorApiError extends Error {
  constructor(
    public status: number,
    public endpoint: string,
    public body: unknown,
  ) {
    super(`GECOR API error (${status}) en ${endpoint}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.name = "GecorApiError";
  }
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
  private currentUser: GecorUser | null = null;
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

  getCurrentUser(): GecorUser | null {
    return this.currentUser;
  }

  private async post<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/${endpoint.replace(/^\//, "")}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (!res.ok) {
      throw new GecorApiError(res.status, endpoint, data);
    }

    return data as T;
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
    const token = await this.ensureAuthenticated();
    const ayto = await this.getAyuntamiento(input.ayuntamientoID ?? this.ayuntamientoID);

    const payload: NuevaIncidenciaInput = {
      token,
      ayuntamientoID: ayto.AyuntamientoID,
      tipoProcedenciaID: input.tipoProcedenciaID ?? ayto.ProcedenciaWeb ?? 1390,
      ciudadanoID: input.ciudadanoID ?? this.currentUser?.CiudadanoID ?? 0,
      nombrePeticionario: input.nombrePeticionario ?? this.currentUser?.Nombre ?? "Ciudadano",
      email: input.email ?? this.currentUser?.Email ?? "",
      movil: input.movil ?? this.currentUser?.Movil ?? "",
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
