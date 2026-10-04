#!/usr/bin/env node
/**
 * CLI de apoyo y pruebas para Chiclana / GECOR
 */
import { GecorClient } from "./client.js";
import { parsePhoto } from "./photo.js";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "help";
  const client = new GecorClient();

  try {
    switch (command) {
      case "ayuntamientos": {
        const query = args[1]?.toLowerCase();
        const list = await client.getAyuntamientos();
        const filtered = query
          ? list.filter((a) => a.Nombre.toLowerCase().includes(query))
          : list;
        console.log(`Municipios encontrados (${filtered.length}):`);
        for (const a of filtered) {
          console.log(`- [${a.AyuntamientoID}] ${a.Nombre} (GPS: ${a.Latitud}, ${a.Longitud})`);
        }
        break;
      }

      case "whoami": {
        const ayto = await client.getAyuntamiento();
        const user = client.getCurrentUser();
        console.log("Ayuntamiento configurado:", ayto.Nombre, `(ID: ${ayto.AyuntamientoID})`);
        console.log("Tiene token activo:", client.hasToken());
        if (user) {
          console.log("Usuario:", user.Nombre || user.Email || user.UsuarioID);
          console.log("Email:", user.Email);
        }
        break;
      }

      case "categories": {
        const query = args[1]?.toLowerCase();
        const tipologia = await client.getTipologia();
        const incidencias = tipologia.Incidencias || [];
        const elementos = tipologia.Elementos || [];
        const familias = tipologia.Familias || [];

        let count = 0;
        for (const inc of incidencias) {
          const elem = elementos.find((e) => e.TipoElementoID === inc.TipoElementoID);
          const fam = familias.find((f) => f.FamiliaID === inc.TipoIncFamilia);

          const str = `${fam?.Nombre || ""} > ${elem?.DesTipoElemento || ""} > ${inc.TipoInc}`;
          if (!query || str.toLowerCase().includes(query)) {
            console.log(`[ElemID: ${inc.TipoElementoID} | IncID: ${inc.TipoIncID}] ${str}`);
            count++;
          }
        }
        console.log(`\nTotal tipologías: ${count}`);
        break;
      }

      case "photo": {
        const filePath = args[1];
        if (!filePath) {
          console.error("Uso: chiclana-avisos-cli photo <ruta-imagen.jpg>");
          process.exit(1);
        }
        const info = await parsePhoto(undefined, filePath);
        console.log("Información de la fotografía:");
        console.log("Bytes:", info.bytes);
        console.log("Cámara:", [info.make, info.model].filter(Boolean).join(" ") || "Desconocida");
        console.log("Fecha:", info.takenAt || "No disponible");
        console.log("GPS:", info.gps ? `${info.gps.lat}, ${info.gps.lng}` : "Sin coordenadas EXIF");
        if (info.warning) console.log("Aviso:", info.warning);
        break;
      }

      case "calles": {
        const query = args[1]?.toLowerCase();
        const calles = await client.getCalles();
        const matches = query
          ? calles.filter((c) => c.Nombre.toLowerCase().includes(query))
          : calles;
        console.log(`Calles encontradas (${matches.length}):`);
        for (const c of matches.slice(0, 20)) {
          console.log(`- [ID: ${c.CalleID}] ${c.TipoVia || ""} ${c.Nombre}`);
        }
        break;
      }

      default: {
        console.log(`
Uso de chiclana-avisos-cli:
  chiclana-avisos-cli whoami                   Ver estado de autenticación y municipio
  Autenticación: configura GECOR_TOKEN en el entorno de esta entrada MCP (no globalmente).
  chiclana-avisos-cli categories [filtro]      Listar tipologías/categorías de averías
  chiclana-avisos-cli calles [filtro]          Buscar calles en el callejero
  chiclana-avisos-cli photo <ruta-imagen.jpg>  Comprobar EXIF y GPS de una fotografía
  chiclana-avisos-cli ayuntamientos [filtro]    Listar municipios GECOR
        `);
      }
    }
  } catch (err: any) {
    console.error("Error:", err.message || err);
    process.exit(1);
  }
}

main();
