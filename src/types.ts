/**
 * Modelos de datos de la API de GECOR
 */

export interface GecorAyuntamiento {
  AyuntamientoID: number;
  Nombre: string;
  ProcedenciaMovil: number;
  ProcedenciaTecnico: number;
  ProcedenciaWeb: number;
  UsuarioIDCiudadano: number;
  TokenAyuntamiento?: string | null;
  Latitud: number;
  Longitud: number;
  Logo?: string | null;
  AvisoLegal?: string | null;
  RutaAppAndroid?: string | null;
  RutaAppiOS?: string | null;
  [key: string]: unknown;
}

export interface GecorUser {
  token: string | null;
  UsuarioID: number;
  CiudadanoID?: number;
  Nombre?: string | null;
  Apellidos?: string | null;
  Email?: string | null;
  Movil?: string | null;
  Activo: boolean;
  AyuntamientoID?: number;
  [key: string]: unknown;
}

export interface GecorFamilia {
  FamiliaID: number;
  Nombre: string;
  AyuntamientoID?: number;
  Icono?: string | null;
  [key: string]: unknown;
}

export interface GecorElemento {
  TipoElementoID: number;
  FamiliaTipoElementoID: number;
  DesTipoElemento: string;
  [key: string]: unknown;
}

export interface GecorIncidenciaTipo {
  TipoIncID: number;
  TipoElementoID: number;
  TipoIncFamilia: number;
  TipoInc: string;
  [key: string]: unknown;
}

export interface GecorTipologiaResponse {
  Error?: {
    Code: number;
    Error: string;
    Message: string | null;
  } | null;
  Familias?: GecorFamilia[] | null;
  Elementos?: GecorElemento[] | null;
  Incidencias?: GecorIncidenciaTipo[] | null;
}

export interface GecorCalle {
  CalleID: number;
  TipoViaID?: number;
  Nombre: string;
  TipoVia?: string | null;
  Numero?: number | null;
  CoordX?: number;
  CoordY?: number;
  [key: string]: unknown;
}

export interface GecorEdificio {
  EdificioID: number;
  NombreEdificio: string;
  [key: string]: unknown;
}

export interface GecorFotoUploadResponse {
  rutaFoto: string;
  [key: string]: unknown;
}

export interface GecorAvisoItem {
  AvisoID: number;
  AvisoCiudadanoID?: number;
  CodAviso?: string | null;
  FechaHoraRegistro?: string;
  DesAveria?: string | null;
  Familia?: string | null;
  DesTipoElemento?: string | null;
  TipoInc?: string | null;
  NomCalle?: string | null;
  NumCalle?: number | null;
  DesUbicacion?: string | null;
  EstadoAvisoID?: number;
  DesEstadoAviso?: string | null;
  Lat?: number;
  Lng?: number;
  X?: number;
  Y?: number;
  Fotos?: Array<{ RutaFoto: string }>;
  [key: string]: unknown;
}

export interface NuevaIncidenciaInput {
  token: string;
  ayuntamientoID: number;
  tipoProcedenciaID: number;
  usuarioID?: number;
  ciudadanoID?: number;
  nombrePeticionario?: string;
  email?: string;
  movil?: string;
  tipoElementoID: number;
  desTipoElemento?: string;
  tipoIncID: number;
  tipoInc?: string;
  desAveria: string;
  x: number;
  y: number;
  calleID?: number;
  nomCalle?: string;
  numCalle?: number;
  desUbicacion?: string;
  edificioID?: number;
  nombreEdificio?: string;
  fotos?: Array<{ rutaFoto: string }>;
  tokenAyto?: string | null;
  estadoAvisoID?: number;
}
