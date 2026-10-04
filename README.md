# chiclana-avisos-mcp (GECOR Avisos MCP)

Servidor **Model Context Protocol (MCP)** para gestionar avisos e incidencias municipales en **Chiclana de la Frontera (Cádiz)** y cualquier municipio soportado por la plataforma **GECOR**.

Inspirado en el diseño y patrones de seguridad de [madrid-avisos-mcp](https://github.com/Naroh091/madrid-avisos-mcp).

Permite que un agente de IA pueda:
- Recibir una foto y dirección o referencia escrita, y extraer GPS EXIF cuando exista.
- Elegir categorías oficiales GECOR y aclarar dudas antes de actuar.
- Previsualizar un aviso sin enviarlo y registrarlo solo tras confirmación explícita del resumen exacto.
- Consultar incidencias previamente registradas y su estado.

---

## 🚀 Inicio Rápido

### 1. Obtener el token de GECOR

Autentica con GECOR y obtén el token de la sesión (por ejemplo, desde `localStorage` en DevTools de [gecorweb.com](https://gecorweb.com/login), clave `user` → campo `token`). El servidor únicamente acepta `GECOR_TOKEN` en el entorno de su propio proceso MCP. No guarda sesiones ni admite inicio de sesión con email y contraseña.

### 2. Configurar en tu cliente MCP

#### Claude Desktop / Claude Code

Añade a tu fichero de configuración de MCP (`claude_desktop_config.json` o settings de Claude Code):

```json
{
  "mcpServers": {
    "chiclana-avisos": {
      "command": "node",
      "args": ["/ruta/absoluta/a/chiclana-avisos-mcp/dist/index.js"],
      "env": {
        "GECOR_AYTO_ID": "268",
        "GECOR_TOKEN": "<tu-token-gecor>"
      }
    }
  }
}
```
Configura el token directamente en `env` para **cada entrada MCP** que inicie este servidor. No uses una exportación global del token: así las credenciales quedan limitadas al proceso MCP correspondiente.

---

## 🛠️ Herramientas MCP Disponibles

| Tool | Descripción |
|---|---|
| `whoami` | Muestra el municipio activo y si `GECOR_TOKEN` está configurado. |
| `list_ayuntamientos` | Lista los 49 municipios soportados por la plataforma GECOR (con buscador). |
| `set_ayuntamiento` | Cambia el municipio activo dinámicamente (`ayuntamientoID`). |
| `list_categories` | Lista las familias, elementos/subcategorías y tipologías de avería disponibles (admite filtro de texto: ej. `farola`, `basura`). |
| `resolve_location` | Resuelve calles georreferenciadas por coordenadas GPS o busca en el callejero oficial de GECOR. |
| `parse_photo_gps` | Extrae metadatos y coordenadas GPS EXIF de una imagen (fichero local o base64). |
| `create_aviso_from_photo` | Flujo de dos fases: primero recibe descripción, categoría GECOR, ubicación y foto sin campos de confirmación y devuelve una previsualización; después acepta únicamente `preview_token`, `confirm: true` y `human_confirmed: true`. La foto se sube solo en el envío confirmado. |
| `list_my_avisos` | Lista las incidencias creadas por el usuario con su estado actual de tramitación. |

---

## 🔒 Seguridad y Filosofía Dry-run

El flujo de envío requiere confirmación explícita; la previsualización por sí sola no crea ningún aviso:

1. Para previsualizar, llama `create_aviso_from_photo` primero con los campos del aviso y la foto; no envíes token ni campos de confirmación. Usa `list_categories` para identificar categorías. Si usas `parse_photo_gps`, utiliza solo el campo `gps`; no muestres los metadatos EXIF `make`, `model` ni `takenAt`.
2. Muestra un resumen breve de categoría, descripción, dirección/referencia, foto y ubicación disponible. No incluyas peticionario, tokens, payload crudo ni identidad privada.
3. Espera un sí inequívoco al resumen exacto en la misma conversación. Ante cambios o respuesta ambigua, crea una previsualización nueva y vuelve a pedir confirmación.
4. Tras confirmar, llama al mismo tool solo con `preview_token`, `confirm: true` y `human_confirmed: true`. Si el guard está deshabilitado o falla la llamada, informa que el aviso NO se envió; nunca eludas el guard ni reintentes una escritura posiblemente completada.
5. `estado: ENVIADO_EXITOSAMENTE` en la respuesta wrapper de Chiclana indica que la llamada MCP/API tuvo éxito, no que ese sea el estado de tramitación municipal. Comunica únicamente lo que devolvió la API: informa un número oficial de ticket o estado de tramitación solo si aparece en `resultado` devuelto por GECOR o está verificado inequívocamente; no lo adivines.

La dirección textual no se geocodifica en este proyecto. Si la foto no aporta GPS EXIF, solicita un pin de Telegram o coordenadas explícitas; nunca inventes ubicación. Prefiere la foto original/documento para conservar EXIF. `image_path` solo funciona cuando el proceso MCP puede acceder a la ruta local de Telegram; no se admite subida remota HTTP.

### Skill de Hermes para Telegram

El artefacto de instrucciones está en [`skill/SKILL.md`](skill/SKILL.md). La instalación es manual: copia ese archivo a `~/.hermes/skills/chiclana-avisos/SKILL.md`. Hermes y el proceso MCP deben ejecutarse en un entorno que permita al MCP acceder a la ruta local de la foto; no cambies configuración externa de Hermes o Telegram como parte de este proyecto.

`GECOR_ALLOW_SUBMISSION=false` sigue siendo el valor seguro por defecto para desarrollo: las previsualizaciones no envían el aviso y el guard no debe eludirse.

---

## 🌐 Soporte Multi-Ayuntamiento

Aunque está preconfigurado por defecto para **Chiclana de la Frontera (ID 268)**, el servidor funciona con cualquier municipio que emplee GECOR (Torremolinos, Vélez-Málaga, Viladecans, etc.).

Para listar todos los municipios disponibles:
```bash
node dist/cli.js ayuntamientos
```

Para usar otro municipio por defecto, define la variable de entorno:
```bash
export GECOR_AYTO_ID=143 # Ejemplo: Torremolinos
```

---

## 💻 CLI de Apoyo

Se incluye una utilidad de línea de comandos para realizar pruebas directas:

```bash
node dist/cli.js ayuntamientos [filtro]    # Buscar municipios GECOR
node dist/cli.js whoami                   # Ver estado de configuración
node dist/cli.js categories [filtro]      # Ver categorías y tipologías
node dist/cli.js photo <foto.jpg>         # Inspeccionar metadatos GPS EXIF de una foto
node dist/cli.js calles [filtro]          # Consultar callejero oficial
```

---

## 🏗️ Construcción y Desarrollo

```bash
npm install
npm run build
```
