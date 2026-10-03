/**
 * Cliente de conexión directa a la API REST de GECOR
 */
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  GECOR_API_URL,
  DEFAULT_AYTO_ID,
  DEFAULT_LANGUAGE,
  GECOR_TOKEN,
  GECOR_EMAIL,
  GECOR_PASSWORD,
  DEFAULT_TOKEN_STORE_PATH,
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

export interface GecorSessionData {
  token: string;
  email?: string;
  usuarioID?: number;
  nombre?: string;
  ayuntamientoID?: number;
  obtainedAt?: number;
}

export interface GecorClientOptions {
  token?: string;
  email?: string;
  password?: string;
  ayuntamientoID?: number;
  language?: string;
  baseUrl?: string;
  tokenStore?: string;
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

export class GecorClient {
  private token: string;
  private email: string;
  private password: string;
  public ayuntamientoID: number;
  public language: string;
  private baseUrl: string;
  private tokenStorePath: string;
  private currentUser: GecorUser | null = null;
  private currentAyuntamiento: GecorAyuntamiento | null = null;

  constructor(opts: GecorClientOptions = {}) {
    this.tokenStorePath = opts.tokenStore ?? DEFAULT_TOKEN_STORE_PATH;

    // Intentar leer token previo guardado en disco
    let storedSession: GecorSessionData | undefined;
    if (this.tokenStorePath) {
      try {
        storedSession = JSON.parse(readFileSync(this.tokenStorePath, "utf-8")) as GecorSessionData;
      } catch {
        // Archivo no existe todavía
      }
    }

    this.token = opts.token ?? storedSession?.token ?? GECOR_TOKEN;
    this.email = opts.email ?? storedSession?.email ?? GECOR_EMAIL;
    this.password = opts.password ?? GECOR_PASSWORD;
    this.ayuntamientoID = opts.ayuntamientoID ?? storedSession?.ayuntamientoID ?? DEFAULT_AYTO_ID;
    this.language = opts.language ?? DEFAULT_LANGUAGE;
    this.baseUrl = opts.baseUrl ?? GECOR_API_URL;

    if (storedSession?.usuarioID) {
      this.currentUser = {
        token: this.token,
        UsuarioID: storedSession.usuarioID,
        Nombre: storedSession.nombre ?? null,
        Email: storedSession.email ?? null,
        Activo: true,
        AyuntamientoID: this.ayuntamientoID,
      };
    }
  }

  hasToken(): boolean {
    return Boolean(this.token && this.token.trim().length > 0);
  }

  getToken(): string {
    return this.token;
  }

  async saveSession(session: GecorSessionData): Promise<void> {
    this.token = session.token;
    if (session.ayuntamientoID) this.ayuntamientoID = session.ayuntamientoID;
    try {
      await writeFile(this.tokenStorePath, JSON.stringify(session, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error(`[chiclana-avisos-mcp] Error guardando sesión en ${this.tokenStorePath}:`, err);
    }
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
    const list = await this.getAyuntamientos();
    const found = list.find((a) => a.AyuntamientoID === ayuntamientoID);
    if (!found) {
      throw new Error(`Ayuntamiento con ID ${ayuntamientoID} no encontrado en GECOR.`);
    }
    this.currentAyuntamiento = found;
    return found;
  }

  /**
   * Inicia sesión con email y contraseña en el ayuntamiento indicado y persiste la sesión
   */
  async login(email = this.email, password = this.password, ayuntamientoID = this.ayuntamientoID): Promise<GecorUser> {
    if (!email || !password) {
      throw new Error("Se requiere email y contraseña para iniciar sesión en GECOR.");
    }
    const user = await this.post<GecorUser>("User/loginUser", {
      email,
      password,
      ayuntamientoID,
      dispositivo: "WebCiudadano",
    });

    if (!user.token) {
      throw new Error(`Error de autenticación en GECOR: credenciales inválidas para el ayuntamiento ${ayuntamientoID}.`);
    }

    this.token = user.token;
    this.currentUser = user;
    this.ayuntamientoID = ayuntamientoID;

    // Guardar automáticamente en disco para no requerir variables de entorno
    await this.saveSession({
      token: user.token,
      email: user.Email ?? email,
      usuarioID: user.UsuarioID,
      nombre: user.Nombre ?? undefined,
      ayuntamientoID,
      obtainedAt: Date.now(),
    });

    return user;
  }

  /**
   * Guarda un token manual (obtenido por ejemplo de gecorweb.com)
   */
  async setTokenManual(token: string, email?: string): Promise<void> {
    this.token = token.trim();
    await this.saveSession({
      token: this.token,
      email: email ?? this.email,
      ayuntamientoID: this.ayuntamientoID,
      obtainedAt: Date.now(),
    });
  }

  /**
   * Comprueba el estado del token o intenta autenticarse si hay credenciales
   */
  async ensureAuthenticated(): Promise<string> {
    if (this.hasToken()) {
      return this.token;
    }
    if (this.email && this.password) {
      const user = await this.login();
      return user.token!;
    }
    throw new Error(
      "No hay token ni sesión activa guardada. Puedes iniciar sesión con: 'chiclana-avisos-cli login <email> <password>' o con 'set_token'.",
    );
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
    const cleanBase64 = base64Image.replace(/^data:image\/[\w+.-]+;base64,/, "").trim();
    const res = await this.post<GecorFotoUploadResponse>("Incident/guardarFotoBase64", {
      token,
      byteFoto: cleanBase64,
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
  async nuevaIncidencia(input: Omit<NuevaIncidenciaInput, "token" | "ayuntamientoID" | "tipoProcedenciaID"> & {
    ayuntamientoID?: number;
    tipoProcedenciaID?: number;
  }): Promise<Record<string, unknown>> {
    const token = await this.ensureAuthenticated();
    const ayto = await this.getAyuntamiento(input.ayuntamientoID ?? this.ayuntamientoID);

    const payload: NuevaIncidenciaInput = {
      token,
      ayuntamientoID: ayto.AyuntamientoID,
      tipoProcedenciaID: input.tipoProcedenciaID ?? ayto.ProcedenciaWeb ?? 1390,
      usuarioID: input.usuarioID ?? this.currentUser?.UsuarioID ?? ayto.UsuarioIDCiudadano,
      ciudadanoID: input.ciudadanoID ?? this.currentUser?.CiudadanoID ?? 0,
      nombrePeticionario: input.nombrePeticionario ?? this.currentUser?.Nombre ?? "Ciudadano",
      email: input.email ?? this.currentUser?.Email ?? "",
      movil: input.movil ?? this.currentUser?.Movil ?? "",
      tipoElementoID: input.tipoElementoID,
      desTipoElemento: input.desTipoElemento ?? "",
      tipoIncID: input.tipoIncID,
      tipoInc: input.tipoInc ?? "",
      desAveria: input.desAveria,
      x: input.x,
      y: input.y,
      calleID: input.calleID ?? 0,
      nomCalle: input.nomCalle ?? "",
      numCalle: input.numCalle ?? 0,
      desUbicacion: input.desUbicacion ?? "",
      edificioID: input.edificioID ?? 0,
      nombreEdificio: input.nombreEdificio ?? "",
      fotos: input.fotos ?? [],
      tokenAyto: ayto.TokenAyuntamiento ?? null,
      estadoAvisoID: -1,
    };

    const res = await this.post<any>("Incident/nuevaIncidencia", payload as unknown as Record<string, unknown>);
    return Array.isArray(res) ? res[0] : res;
  }
}
