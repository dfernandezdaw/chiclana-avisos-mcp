/**
 * Servidor MCP para GECOR / Chiclana de la Frontera
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GecorClient } from "./client.js";
import { parsePhoto } from "./photo.js";
import { DEFAULT_AYTO_ID, DEFAULT_AYTO_NAME } from "./config.js";

export function createMcpServer(client: GecorClient = new GecorClient()): Server {
  const server = new Server(
    {
      name: "chiclana-avisos-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "whoami",
          description: "Muestra el estado de la sesión, usuario autenticado y municipio activo configurado en GECOR.",
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
          name: "parse_photo_gps",
          description: "Extrae metadatos y coordenadas GPS EXIF de una imagen (ruta local o base64). Útil para geolocalizar incidencias automáticamente desde la fotografía.",
          inputSchema: {
            type: "object",
            properties: {
              image_path: {
                type: "string",
                description: "Ruta absoluta o relativa del fichero de imagen en el disco local.",
              },
              image_base64: {
                type: "string",
                description: "Cadena de la imagen en base64 (JPEG/PNG).",
              },
            },
          },
        },
        {
          name: "create_aviso_preview",
          description: "Prepara y previsualiza un aviso municipal sin enviarlo al ayuntamiento (dry-run). Puede extraer el GPS automáticamente si se proporciona una foto. Devuelve el resumen exacto de lo que se enviaría.",
          inputSchema: {
            type: "object",
            properties: {
              description: {
                type: "string",
                description: "Descripción detallada del desperfecto o problema.",
              },
              tipoElementoID: {
                type: "number",
                description: "ID del elemento/subcategoría obtenido de list_categories.",
              },
              tipoIncID: {
                type: "number",
                description: "ID del tipo de incidencia obtenido de list_categories.",
              },
              desTipoElemento: {
                type: "string",
                description: "Nombre del elemento/subcategoría.",
              },
              tipoInc: {
                type: "string",
                description: "Nombre del tipo de incidencia.",
              },
              lat: {
                type: "number",
                description: "Latitud de la incidencia.",
              },
              lng: {
                type: "number",
                description: "Longitud de la incidencia.",
              },
              nomCalle: {
                type: "string",
                description: "Nombre de la calle.",
              },
              numCalle: {
                type: "number",
                description: "Número de portal o altura de la calle.",
              },
              calleID: {
                type: "number",
                description: "ID de la calle en el callejero oficial si se obtuvo de resolve_location.",
              },
              desUbicacion: {
                type: "string",
                description: "Detalle adicional de la ubicación (ej: 'frente al parque infantil').",
              },
              image_path: {
                type: "string",
                description: "Ruta local de una fotografía a adjuntar.",
              },
              image_base64: {
                type: "string",
                description: "Imagen en base64 a adjuntar.",
              },
            },
            required: ["description", "tipoElementoID", "tipoIncID"],
          },
        },
        {
          name: "create_aviso",
          description: "Crea y envía formalmente la incidencia al ayuntamiento a través de GECOR. IMPORTANTE: Opera en modo seguro; por defecto sólo simula el envío (dry-run) a menos que se especifique explícitamente confirm: true.",
          inputSchema: {
            type: "object",
            properties: {
              description: {
                type: "string",
                description: "Descripción del desperfecto o problema.",
              },
              tipoElementoID: {
                type: "number",
                description: "ID del elemento/subcategoría.",
              },
              tipoIncID: {
                type: "number",
                description: "ID del tipo de incidencia.",
              },
              desTipoElemento: {
                type: "string",
                description: "Nombre del elemento.",
              },
              tipoInc: {
                type: "string",
                description: "Nombre de la incidencia.",
              },
              lat: {
                type: "number",
                description: "Latitud de la ubicación.",
              },
              lng: {
                type: "number",
                description: "Longitud de la ubicación.",
              },
              nomCalle: {
                type: "string",
                description: "Nombre de la calle.",
              },
              numCalle: {
                type: "number",
                description: "Número de calle.",
              },
              calleID: {
                type: "number",
                description: "ID de la calle (opcional si no se conoce).",
              },
              desUbicacion: {
                type: "string",
                description: "Detalle de ubicación adicional.",
              },
              image_path: {
                type: "string",
                description: "Ruta local de una fotografía a adjuntar y subir a GECOR.",
              },
              image_base64: {
                type: "string",
                description: "Foto en base64 a subir a GECOR.",
              },
              confirm: {
                type: "boolean",
                description: "Debe ser explícitamente 'true' para realizar la llamada POST real al ayuntamiento. Si es false o ausente, devuelve una simulación segura.",
              },
            },
            required: ["description", "tipoElementoID", "tipoIncID", "lat", "lng"],
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
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "whoami": {
          const ayto = await client.getAyuntamiento();
          const user = client.getCurrentUser();
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
                    usuario: user
                      ? {
                          UsuarioID: user.UsuarioID,
                          Nombre: user.Nombre,
                          Email: user.Email,
                          Activo: user.Activo,
                        }
                      : null,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        case "list_ayuntamientos": {
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
        }

        case "set_ayuntamiento": {
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
        }

        case "list_categories": {
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
        }

        case "resolve_location": {
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
        }

        case "parse_photo_gps": {
          const imagePath = typeof args?.image_path === "string" ? args.image_path : undefined;
          const imageBase64 = typeof args?.image_base64 === "string" ? args.image_base64 : undefined;
          const photoInfo = await parsePhoto(imageBase64, imagePath);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    gps: photoInfo.gps,
                    make: photoInfo.make,
                    model: photoInfo.model,
                    takenAt: photoInfo.takenAt,
                    warning: photoInfo.warning,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        case "create_aviso_preview": {
          let lat = args?.lat !== undefined ? Number(args.lat) : undefined;
          let lng = args?.lng !== undefined ? Number(args.lng) : undefined;
          const imagePath = typeof args?.image_path === "string" ? args.image_path : undefined;
          const imageBase64 = typeof args?.image_base64 === "string" ? args.image_base64 : undefined;

          let photoWarning: string | undefined;
          let hasPhoto = false;

          if (imagePath || imageBase64) {
            hasPhoto = true;
            try {
              const photo = await parsePhoto(imageBase64, imagePath);
              if (photo.gps && (lat === undefined || lng === undefined)) {
                lat = photo.gps.lat;
                lng = photo.gps.lng;
              }
              if (photo.warning) photoWarning = photo.warning;
            } catch (err: any) {
              photoWarning = `No se pudo procesar la imagen: ${err.message}`;
            }
          }

          const ayto = await client.getAyuntamiento();

          const preview = {
            modo: "DRY-RUN (Simulación / Previsualización)",
            ayuntamiento: ayto.Nombre,
            ayuntamientoID: ayto.AyuntamientoID,
            categoria: {
              tipoElementoID: args?.tipoElementoID,
              desTipoElemento: args?.desTipoElemento,
              tipoIncID: args?.tipoIncID,
              tipoInc: args?.tipoInc,
            },
            ubicacion: {
              lat: lat ?? "No especificada (requerida para envío)",
              lng: lng ?? "No especificada (requerida para envío)",
              nomCalle: args?.nomCalle,
              numCalle: args?.numCalle,
              desUbicacion: args?.desUbicacion,
              calleID: args?.calleID,
            },
            descripcion: args?.description,
            foto_adjunta: hasPhoto,
            aviso_foto: photoWarning,
            instruccion: "Muestra este resumen al usuario. Si da su confirmación, llama a 'create_aviso' con confirm: true.",
          };

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(preview, null, 2),
              },
            ],
          };
        }

        case "create_aviso": {
          const confirm = Boolean(args?.confirm);
          const description = String(args?.description || "");
          const tipoElementoID = Number(args?.tipoElementoID);
          const tipoIncID = Number(args?.tipoIncID);
          const lat = Number(args?.lat);
          const lng = Number(args?.lng);

          const imagePath = typeof args?.image_path === "string" ? args.image_path : undefined;
          const imageBase64 = typeof args?.image_base64 === "string" ? args.image_base64 : undefined;

          if (!confirm) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      estado: "DRY-RUN_NO_ENVIADO",
                      motivo: "Se requiere 'confirm: true' para registrar el aviso real ante el Ayuntamiento.",
                      payload_preparado: {
                        description,
                        tipoElementoID,
                        tipoIncID,
                        lat,
                        lng,
                        nomCalle: args?.nomCalle,
                        numCalle: args?.numCalle,
                        desUbicacion: args?.desUbicacion,
                      },
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }

          // Si hay foto y confirmación, se sube primero la foto a GECOR
          const fotos: Array<{ rutaFoto: string }> = [];
          if (imagePath || imageBase64) {
            const photo = await parsePhoto(imageBase64, imagePath);
            const ruta = await client.guardarFotoBase64(photo.base64);
            fotos.push({ rutaFoto: ruta });
          }

          const resultado = await client.nuevaIncidencia({
            tipoElementoID,
            desTipoElemento: typeof args?.desTipoElemento === "string" ? args.desTipoElemento : "",
            tipoIncID,
            tipoInc: typeof args?.tipoInc === "string" ? args.tipoInc : "",
            desAveria: description,
            x: lat,
            y: lng,
            calleID: args?.calleID ? Number(args.calleID) : 0,
            nomCalle: typeof args?.nomCalle === "string" ? args.nomCalle : "",
            numCalle: args?.numCalle ? Number(args.numCalle) : 0,
            desUbicacion: typeof args?.desUbicacion === "string" ? args.desUbicacion : "",
            fotos,
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
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

        case "list_my_avisos": {
          const list = await client.getMisIncidencias();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(list, null, 2),
              },
            ],
          };
        }

        default:
          throw new Error(`Tool desconocida: ${name}`);
      }
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
  console.error(`Servidor MCP chiclana-avisos-mcp iniciado (Ayto ID: ${DEFAULT_AYTO_ID} - ${DEFAULT_AYTO_NAME}).`);
}
