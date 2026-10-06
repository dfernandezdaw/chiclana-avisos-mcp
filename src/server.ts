/**
 * Servidor MCP para GECOR / Chiclana de la Frontera
 */
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { GecorApiError, GecorClient } from "./client.js";
import { parsePhoto, type PhotoInfo } from "./photo.js";
import { DEFAULT_AYTO_ID, PACKAGE_VERSION } from "./config.js";

interface PendingAvisoPreview {
  payload: {
    description: string;
    petitioner: { Nombre: string; Email: string; Movil: string; CiudadanoID: number };
    tipoElementoID: number;
    tipoIncID: number;
    desTipoElemento: string;
    tipoInc: string;
    lat: number;
    lng: number;
    numCalle: number;
    calleID: number;
    desUbicacion: string;
  };
  photoDataUri?: string;
  ayuntamientoID: number;
  expiresAt: number;
}

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_PREVIEWS = 100;
const MAX_DESCRIPTION_LENGTH = 1000;

type ToolArgs = Record<string, unknown> | undefined;
type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: ToolContent[]; isError?: boolean };
type ToolHandler = (args: ToolArgs) => Promise<ToolResult>;

function parseCoordinate(value: unknown, min: number, max: number, label: "Latitud" | "Longitud"): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} inválida: debe ser un número entre ${min} y ${max}.`);
  return n;
}

/** Bloque de imagen MCP con la miniatura; nunca va dentro del JSON de texto */
function thumbnailContent(photo: PhotoInfo): ToolContent[] {
  return photo.thumbnail ? [{ type: "image", data: photo.thumbnail.base64, mimeType: photo.thumbnail.mime }] : [];
}

/** Mensaje accionable cuando no hay coordenadas explícitas ni GPS EXIF utilizable. */
export function missingLocationMessage(photo: Pick<PhotoInfo, "mime" | "warning">): string {
  const cause = photo.mime !== "image/jpeg"
    ? "La foto es PNG (sin EXIF): este formato no incluye ubicación GPS."
    : photo.warning
      ? `La foto JPEG no aporta una ubicación utilizable: ${photo.warning}`
      : "La foto JPEG no contiene etiquetas GPS (es habitual si se envió por Telegram o WhatsApp, que eliminan el EXIF, o si la ubicación estaba desactivada en la cámara).";
  return [
    "No se encontró ninguna ubicación para el aviso.",
    cause,
    "Pide a la persona que comparta un pin de ubicación (lat/lng) o unas coordenadas explícitas, o que reenvíe la foto como archivo/documento para conservar el EXIF.",
    "No inventes coordenadas. Un nombre de calle por sí solo (resolve_location) no aporta coordenadas.",
  ].join(" ");
}

export function createMcpServer(client: GecorClient = new GecorClient()): Server {
  const pendingPreviews = new Map<string, PendingAvisoPreview>();
  const server = new Server(
    {
      name: "chiclana-avisos-mcp",
      version: PACKAGE_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  const tools: Tool[] = [
    {
      name: "whoami",
      description: "Muestra el municipio activo y si GECOR_TOKEN está configurado.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "list_ayuntamientos",
      description: "Lista todos los municipios soportados por la plataforma GECOR (con sus identificadores y nombres).",
      inputSchema: {
        type: "object",
        properties: {
          search: {
            type: "string",
            description: "Filtro opcional por nombre de municipio (ej: 'Chiclana', 'Torremolinos').",
          },
        },
      },
    },
    {
      name: "set_ayuntamiento",
      description: "Cambia el ayuntamiento activo para las consultas e incidencias.",
      inputSchema: {
        type: "object",
        properties: {
          ayuntamientoID: {
            type: "number",
            description: "ID del ayuntamiento (ej: 268 para Chiclana de la Frontera).",
          },
        },
        required: ["ayuntamientoID"],
      },
    },
    {
      name: "list_categories",
      description: "Obtiene el catálogo de tipologías de incidencias (familias, elementos/subcategorías y tipos de incidencia) para el ayuntamiento activo.",
      inputSchema: {
        type: "object",
        properties: {
          search: {
            type: "string",
            description: "Filtro opcional de texto para buscar por familia, elemento o tipo de avería (ej: 'farola', 'basura', 'acera').",
          },
        },
      },
    },
    {
      name: "resolve_location",
      description: "Valida y resuelve una ubicación en el municipio activo mediante coordenadas GPS o búsqueda de calles en el callejero oficial de GECOR.",
      inputSchema: {
        type: "object",
        properties: {
          lat: {
            type: "number",
            description: "Latitud GPS (ej: 36.4165)",
          },
          lng: {
            type: "number",
            description: "Longitud GPS (ej: -6.1461)",
          },
          street_name: {
            type: "string",
            description: "Nombre de la calle o texto de búsqueda si no se tienen coordenadas exactas.",
          },
        },
      },
    },
    {
      name: "create_aviso_from_photo",
      description: "Única herramienta para avisos, en dos fases. Para previsualizar, llama con los campos del aviso y una foto obligatoria (image_path o image_base64), sin preview_token ni campos de confirmación. La previsualización devuelve además una miniatura de la foto (imagen JPEG ≤1024 px sin EXIF, o el PNG pequeño tal cual) para que redactes la descripción y compruebes la categoría con lo visible; si omites description, devuelve phase: need_description con la miniatura y sin preview_token. Enseña el resumen exacto y espera un sí explícito. Solo entonces vuelve a llamar con únicamente preview_token, confirm:true y human_confirmed:true. Si el usuario pide cambios, crea una nueva previsualización; nunca envíes por inferencia. La previsualización no envía nada; confirmar envía un aviso real al ayuntamiento y la foto se sube únicamente durante ese envío confirmado.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          description: { type: "string", description: "Descripción factual del desperfecto, redactada por el agente a partir de lo visible en la foto y lo que diga el usuario (1–2 frases; no inventes datos). Si se omite, la previsualización devuelve la miniatura para redactarla." },
          tipoElementoID: { type: "number", description: "ID de elemento/subcategoría de list_categories." },
          tipoIncID: { type: "number", description: "ID del tipo de incidencia de list_categories." },
          desTipoElemento: { type: "string", description: "Nombre del elemento/subcategoría." },
          tipoInc: { type: "string", description: "Nombre del tipo de incidencia." },
          lat: { type: "number", description: "Latitud; puede omitirse si la foto aporta GPS EXIF." },
          lng: { type: "number", description: "Longitud; puede omitirse si la foto aporta GPS EXIF." },
          numCalle: { type: "number", description: "Número del portal, si se conoce." },
          calleID: { type: "number", description: "ID de calle; usa 0 si no se resolvió en el callejero." },
          desUbicacion: { type: "string", description: "Dirección formateada o referencia textual del lugar." },
          image_path: { type: "string", description: "Ruta local de una foto JPEG o PNG dentro de los directorios permitidos (GECOR_PHOTO_DIRS; por defecto tmp, Downloads, Pictures, Desktop y ~/.hermes). Máximo 20 MB salvo GECOR_MAX_PHOTO_BYTES." },
          image_base64: { type: "string", description: "Foto JPEG o PNG en base64 (admite prefijo data:image/...;base64,) si no se dispone de una ruta local." },
          preview_token: { type: "string", description: "Solo para la segunda fase: token exacto devuelto por la previsualización." },
          confirm: { type: "boolean", description: "Solo true tras el sí explícito al resumen exacto." },
          human_confirmed: { type: "boolean", description: "Solo true tras la confirmación humana explícita." },
        },
      },
    },
    {
      name: "list_my_avisos",
      description: "Consulta los avisos previamente registrados por el usuario para consultar su estado de tramitación.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  // Only listed tools are dispatchable; preview/submit are internal functions, not tool names.
  const toolHandlers: Record<string, ToolHandler> = {
    whoami: async () => {
      const ayto = await client.getAyuntamiento();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                municipio_activo: {
                  AyuntamientoID: ayto.AyuntamientoID,
                  Nombre: ayto.Nombre,
                  Latitud: ayto.Latitud,
                  Longitud: ayto.Longitud,
                },
                autenticado: client.hasToken(),
              },
              null,
              2,
            ),
          },
        ],
      };
    },

    list_ayuntamientos: async (args) => {
      const search = typeof args?.search === "string" ? args.search.toLowerCase() : "";
      const list = await client.getAyuntamientos();
      const filtered = search
        ? list.filter((a) => a.Nombre.toLowerCase().includes(search))
        : list;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              filtered.map((a) => ({
                AyuntamientoID: a.AyuntamientoID,
                Nombre: a.Nombre,
                Latitud: a.Latitud,
                Longitud: a.Longitud,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },

    set_ayuntamiento: async (args) => {
      const aytoId = Number(args?.ayuntamientoID);
      if (!aytoId) throw new Error("Parámetro 'ayuntamientoID' requerido.");
      const ayto = await client.getAyuntamiento(aytoId);
      client.ayuntamientoID = aytoId;
      return {
        content: [
          {
            type: "text",
            text: `Municipio activo cambiado exitosamente a: ${ayto.Nombre} (ID: ${ayto.AyuntamientoID})`,
          },
        ],
      };
    },

    list_categories: async (args) => {
      const search = typeof args?.search === "string" ? args.search.toLowerCase() : "";
      const tipologia = await client.getTipologia();

      const familias = tipologia.Familias || [];
      const elementos = tipologia.Elementos || [];
      const incidencias = tipologia.Incidencias || [];

      // Estructurar árbol de categorías para el LLM
      let items: Array<{
        familiaID: number;
        familia: string;
        tipoElementoID: number;
        elemento: string;
        tipoIncID: number;
        incidencia: string;
      }> = [];

      for (const inc of incidencias) {
        const elem = elementos.find((e) => e.TipoElementoID === inc.TipoElementoID);
        const fam = familias.find((f) => f.FamiliaID === inc.TipoIncFamilia);

        items.push({
          familiaID: inc.TipoIncFamilia,
          familia: fam?.Nombre || "",
          tipoElementoID: inc.TipoElementoID,
          elemento: elem?.DesTipoElemento || "",
          tipoIncID: inc.TipoIncID,
          incidencia: inc.TipoInc,
        });
      }

      if (search) {
        items = items.filter(
          (i) =>
            i.familia.toLowerCase().includes(search) ||
            i.elemento.toLowerCase().includes(search) ||
            i.incidencia.toLowerCase().includes(search),
        );
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total_encontrados: items.length,
                categorias: items.slice(0, 100),
              },
              null,
              2,
            ),
          },
        ],
      };
    },

    resolve_location: async (args) => {
      const lat = args?.lat !== undefined ? Number(args.lat) : undefined;
      const lng = args?.lng !== undefined ? Number(args.lng) : undefined;
      const streetName = typeof args?.street_name === "string" ? args.street_name.toLowerCase() : "";

      if (lat !== undefined && lng !== undefined) {
        const nearby = await client.getCallesGeorreferenciadas(lat, lng, 150);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  coordenadas: { lat, lng },
                  calles_cercanas: nearby.slice(0, 5).map((c) => ({
                    CalleID: c.CalleID,
                    Nombre: c.Nombre,
                    TipoVia: c.TipoVia,
                    Numero: c.Numero,
                  })),
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      if (streetName) {
        const allStreets = await client.getCalles();
        const matches = allStreets.filter((s) => s.Nombre.toLowerCase().includes(streetName));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  busqueda: streetName,
                  coincidencias: matches.slice(0, 10).map((c) => ({
                    CalleID: c.CalleID,
                    Nombre: c.Nombre,
                    TipoVia: c.TipoVia,
                  })),
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      throw new Error("Proporciona lat/lng o un street_name.");
    },

    list_my_avisos: async () => {
      const list = await client.getMisIncidencias();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(list, null, 2),
          },
        ],
      };
    },

    create_aviso_from_photo: async (args) => {
      const confirmationFields = ["preview_token", "confirm", "human_confirmed"];
      const hasConfirmation = confirmationFields.some((key) => args?.[key] !== undefined);
      if (!hasConfirmation) return previewAviso(args);
      if (Object.keys(args ?? {}).some((key) => !confirmationFields.includes(key))) throw new Error("La fase de confirmación solo acepta preview_token, confirm y human_confirmed.");
      if (args?.confirm !== true || args?.human_confirmed !== true) throw new Error("Se requiere confirm:true y human_confirmed:true.");
      return submitAviso(args);
    },
  };

  async function previewAviso(args: ToolArgs): Promise<ToolResult> {
    const imagePath = typeof args?.image_path === "string" && args.image_path.trim() ? args.image_path : undefined;
    const imageBase64 = typeof args?.image_base64 === "string" && args.image_base64.trim() ? args.image_base64 : undefined;
    if (!imagePath && !imageBase64) throw new Error("Se requiere una foto mediante image_path o image_base64 para previsualizar.");
    if (imagePath && imageBase64) throw new Error("Proporciona solo image_path o image_base64, no ambos.");

    const description = String(args?.description ?? "").trim();
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error(`La descripción es demasiado larga (máximo ${MAX_DESCRIPTION_LENGTH} caracteres): resúmela en 1–2 frases.`);
    }
    // Sin descripción se devuelve la miniatura para redactarla: la categoría puede elegirse
    // después de ver la foto, así que solo se valida si se indicó.
    for (const key of ["tipoElementoID", "tipoIncID"] as const) {
      if (!description && args?.[key] === undefined) continue;
      const id = Number(args?.[key]);
      if (!Number.isInteger(id) || id <= 0) throw new Error(`${key} debe ser un entero positivo.`);
    }
    const tipoElementoID = Number(args?.tipoElementoID);
    const tipoIncID = Number(args?.tipoIncID);

    const hasLat = args?.lat !== undefined;
    const hasLng = args?.lng !== undefined;
    if (hasLat !== hasLng) {
      throw new Error(`Coordenadas incompletas: falta la ${hasLat ? "longitud" : "latitud"}. Indica ambas (lat y lng) u omite las dos para usar el GPS EXIF de la foto.`);
    }
    let lat = hasLat ? parseCoordinate(args?.lat, -90, 90, "Latitud") : undefined;
    let lng = hasLng ? parseCoordinate(args?.lng, -180, 180, "Longitud") : undefined;

    let photo: PhotoInfo;
    try {
      photo = await parsePhoto(imageBase64, imagePath);
    } catch (err: any) {
      throw new Error(`No se pudo procesar la imagen: ${err.message}`);
    }
    const photoDataUri = photo.dataUri;
    const photoSummary: Record<string, unknown> = {
      mime: photo.mime,
      original_bytes: photo.bytes,
      upload_bytes: photo.uploadBytes,
      width: photo.width,
      height: photo.height,
      reducida: photo.reduced,
      exif_conservado: photo.exifPreserved,
      miniatura: Boolean(photo.thumbnail),
      ...(photo.reductionWarning ? { aviso_reduccion: photo.reductionWarning } : {}),
      ...(photo.thumbnailWarning ? { aviso_miniatura: photo.thumbnailWarning } : {}),
    };
    if (photo.gps && lat === undefined) {
      lat = photo.gps.lat;
      lng = photo.gps.lng;
    }
    const photoWarning = photo.warning;

    if (!description) {
      // Fase sin efectos: no se consulta GECOR ni se guarda ninguna previsualización.
      const needDescription = {
        phase: "need_description",
        foto: photoSummary,
        aviso_foto: photoWarning,
        ...(lat === undefined || lng === undefined ? { aviso_ubicacion: missingLocationMessage(photo) } : {}),
        instruccion: [
          photo.thumbnail
            ? "Mira la miniatura adjunta y redacta en español 1–2 frases factuales con lo visible en la imagen y lo que haya dicho el usuario: el elemento, el daño y dónde está dentro de la imagen."
            : "No hay miniatura disponible: redacta en español 1–2 frases factuales solo con lo que haya dicho el usuario sobre el elemento y el daño.",
          "No inventes datos que no se vean: medidas, peligro, antigüedad ni causas.",
          "Si el daño no está claro, pregunta al usuario antes de redactar.",
          "Después vuelve a llamar a create_aviso_from_photo con la misma foto, la categoría, la ubicación y description.",
        ].join(" "),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(needDescription, null, 2) }, ...thumbnailContent(photo)],
      };
    }

    const petitioner = client.getPetitionerIdentity();
    const ayto = await client.getAyuntamiento();

    if (lat === undefined || lng === undefined) {
      throw new Error(missingLocationMessage(photo));
    }
    // Defensa en profundidad: la ubicación final (explícita o EXIF) debe estar en rango.
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      throw new Error("Ubicación fuera de rango; pide una ubicación válida.");
    }

    const payload: PendingAvisoPreview["payload"] = {
      description,
      petitioner,
      tipoElementoID,
      tipoIncID,
      desTipoElemento: typeof args?.desTipoElemento === "string" ? args.desTipoElemento : "",
      tipoInc: typeof args?.tipoInc === "string" ? args.tipoInc : "",
      lat,
      lng,
      numCalle: args?.numCalle === undefined ? 0 : Number(args.numCalle),
      calleID: args?.calleID === undefined ? 0 : Number(args.calleID),
      desUbicacion: typeof args?.desUbicacion === "string" ? args.desUbicacion : "",
    };
    if (!Number.isFinite(payload.numCalle) || !Number.isInteger(payload.calleID)) throw new Error("Número o identificador de calle inválido.");

    const previewToken = randomUUID();
    const now = Date.now();
    for (const [key, value] of pendingPreviews) if (value.expiresAt <= now) pendingPreviews.delete(key);
    while (pendingPreviews.size >= MAX_PENDING_PREVIEWS) {
      const oldest = pendingPreviews.keys().next().value;
      if (!oldest) break;
      pendingPreviews.delete(oldest);
    }
    pendingPreviews.set(previewToken, { payload, photoDataUri, ayuntamientoID: ayto.AyuntamientoID, expiresAt: now + PREVIEW_TTL_MS });

    const preview = {
      modo: "PREVISUALIZACIÓN (aún no se ha enviado nada ni se ha subido la foto)",
      ayuntamiento: ayto.Nombre,
      ayuntamientoID: ayto.AyuntamientoID,
      categoria: { tipoElementoID, desTipoElemento: payload.desTipoElemento, tipoIncID, tipoInc: payload.tipoInc },
      ubicacion: { lat, lng, numCalle: payload.numCalle, desUbicacion: payload.desUbicacion, calleID: payload.calleID },
      descripcion: payload.description,
      foto_adjunta: true,
      foto: photoSummary,
      aviso_foto: photoWarning,
      preview_token: previewToken,
      expira_en_segundos: PREVIEW_TTL_MS / 1000,
      instruccion: [
        photo.thumbnail
          ? "Antes de mostrar el resumen, mira la miniatura adjunta y verifica que la categoría y la descripción coinciden con lo visible en la imagen; si no coinciden, corrígelas y crea una nueva previsualización."
          : "",
        "Muestra este resumen al usuario, incluida la descripción, y espera su sí explícito: confirmar envía un aviso real al ayuntamiento. Si pide cambios, crea una nueva previsualización. Confirma solo ese sí exacto con create_aviso_from_photo, confirm:true, human_confirmed:true y este preview_token.",
      ].filter(Boolean).join(" "),
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ phase: "preview", ...preview }, null, 2),
        },
        ...thumbnailContent(photo),
      ],
    };
  }

  async function submitAviso(args: ToolArgs): Promise<ToolResult> {
    if (args?.confirm !== true || args?.human_confirmed !== true) {
      throw new Error("No enviado. Se requiere el sí explícito del usuario al resumen mostrado (confirm:true y human_confirmed:true).");
    }
    const previewToken = typeof args?.preview_token === "string" ? args.preview_token : "";
    const preview = pendingPreviews.get(previewToken);
    if (!preview) throw new Error("Previsualización inexistente, vencida o ya utilizada. Genera una nueva previsualización y solicita aprobación otra vez.");
    if (preview.expiresAt <= Date.now()) {
      pendingPreviews.delete(previewToken);
      throw new Error("La previsualización venció. Genera una nueva previsualización y solicita aprobación otra vez.");
    }
    // Burn before any side effect so retries can never create duplicate incidents.
    pendingPreviews.delete(previewToken);

    const fotos: Array<{ rutaFoto: string }> = [];
    if (preview.photoDataUri) {
      try {
        const ruta = await client.guardarFotoBase64(preview.photoDataUri);
        fotos.push({ rutaFoto: ruta });
      } catch (err: any) {
        throw new Error(`No se ha creado ningún aviso: falló la subida de la foto (${err?.message || String(err)}). La previsualización ya se consumió; crea una nueva previsualización y solicita confirmación otra vez.`);
      }
    }
    const payload = preview.payload;
    let resultado: Record<string, unknown>;
    try {
      resultado = await client.nuevaIncidencia({
        ayuntamientoID: preview.ayuntamientoID,
        ciudadanoID: payload.petitioner.CiudadanoID,
        nombrePeticionario: payload.petitioner.Nombre,
        email: payload.petitioner.Email,
        movil: payload.petitioner.Movil,
        tipoElementoID: payload.tipoElementoID,
        desTipoElemento: payload.desTipoElemento,
        tipoIncID: payload.tipoIncID,
        tipoInc: payload.tipoInc,
        desAveria: payload.description,
        x: payload.lat,
        y: payload.lng,
        calleID: payload.calleID,
        numCalle: payload.numCalle,
        desUbicacion: payload.desUbicacion,
        fotos,
      });
    } catch (err: any) {
      // Solo un 4xx descarta que el aviso se haya creado; un 5xx (p. ej. 502/504 de pasarela) es tan ambiguo como un timeout.
      const ambiguous = !(err instanceof GecorApiError && err.kind === "http" && err.status < 500);
      throw new Error([
        `Envío NO confirmado: ${err?.message || String(err)}`,
        fotos.length ? "La foto se subió a GECOR, pero GECOR no confirmó la creación del aviso." : "GECOR no confirmó la creación del aviso.",
        ambiguous ? "Al no haber respuesta definitiva, el resultado es ambiguo: el aviso podría haberse creado igualmente." : "",
        "No reintentes a ciegas: consulta primero list_my_avisos y, solo si el aviso no aparece, crea una nueva previsualización y solicita confirmación otra vez.",
      ].filter(Boolean).join(" "));
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              phase: "submitted",
              estado: "ENVIADO_EXITOSAMENTE",
              resultado,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const listedToolNames = new Set(tools.map((tool) => tool.name));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = listedToolNames.has(name) && Object.hasOwn(toolHandlers, name) ? toolHandlers[name] : undefined;
    if (!handler) {
      return {
        isError: true,
        content: [{ type: "text", text: `Herramienta desconocida: ${name}` }],
      };
    }

    try {
      return await handler(args);
    } catch (err: any) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error ejecutando '${name}': ${err.message || String(err)}`,
          },
        ],
      };
    }
  });

  return server;
}

export async function runServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Servidor MCP chiclana-avisos-mcp iniciado (Ayto ID: ${DEFAULT_AYTO_ID}).`);
}
