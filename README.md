# chiclana-avisos-mcp (GECOR Avisos MCP)

Servidor **Model Context Protocol (MCP)** para gestionar avisos e incidencias municipales en **Chiclana de la Frontera (Cádiz)** y cualquier municipio soportado por la plataforma **GECOR**.

Inspirado en el diseño y patrones de seguridad de [madrid-avisos-mcp](https://github.com/Naroh091/madrid-avisos-mcp).

Permite que un agente de IA pueda:
- Recibir una foto y dirección o referencia escrita, y extraer GPS EXIF cuando exista.
- Elegir categorías oficiales GECOR y aclarar dudas antes de actuar.
- Previsualizar un aviso sin enviarlo y registrarlo solo tras confirmación explícita del resumen exacto.
- Consultar incidencias previamente registradas y su estado.

---

## 📦 Instalación

Requiere Node.js 20 o superior. El paquete se publica en npm como `chiclana-avisos-mcp` y se ejecuta con `npx`, sin clonar el repositorio.

### 1. Obtener el token de GECOR

Autentica con GECOR y obtén el token de la sesión (por ejemplo, desde `localStorage` en DevTools de [gecorweb.com](https://gecorweb.com/login), clave `user` → campo `token`). El servidor únicamente acepta `GECOR_TOKEN` en el entorno de su propio proceso MCP. No guarda sesiones ni admite inicio de sesión con email y contraseña.

### 2. Configurar en tu cliente MCP

#### Claude Desktop

Añade a `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "chiclana-avisos": {
      "command": "npx",
      "args": ["-y", "chiclana-avisos-mcp"],
      "env": {
        "GECOR_TOKEN": "<tu-token-gecor>",
        "GECOR_AYTO_ID": "268"
      }
    }
  }
}
```

#### Claude Code

```bash
claude mcp add chiclana-avisos \
  -e GECOR_TOKEN=<tu-token-gecor> \
  -e GECOR_AYTO_ID=268 \
  -- npx -y chiclana-avisos-mcp
```

#### Otros clientes MCP (OpenCode, Hermes, etc.)

Cualquier cliente que lance servidores MCP por stdio necesita los mismos tres elementos: comando, argumentos y entorno.

- **command**: `npx`
- **args**: `["-y", "chiclana-avisos-mcp"]`
- **env**: `GECOR_TOKEN` y `GECOR_AYTO_ID` (por defecto `268`)

Consulta la documentación de tu cliente para el formato exacto del fichero de configuración.

Confirmar una previsualización envía un aviso real al ayuntamiento. Antes de enviar, el agente siempre te muestra el resumen y espera tu «sÃ­».

### Para agentes de IA

Si eres un agente configurando este servidor para un usuario:

1. Pide al usuario su token de GECOR (ver [1. Obtener el token de GECOR](#1-obtener-el-token-de-gecor)); no lo busques ni lo extraigas por tu cuenta.
2. Configura la entrada MCP con `npx -y chiclana-avisos-mcp` y el token en `env` de esa entrada. Chiclana es `GECOR_AYTO_ID=268`; para otro municipio, obtén su ID con `list_ayuntamientos`.
3. Reinicia el cliente y llama a `whoami`: confirma el municipio activo y que hay token configurado, pero no valida el token. Para comprobar que GECOR lo acepta, llama a `list_my_avisos` (solo lectura).
4. Sigue el flujo de [`skill/SKILL.md`](skill/SKILL.md): previsualizar, mostrar el resumen y enviar solo tras confirmación explícita.
5. Confirmar envía un aviso real al ayuntamiento: llama al envío confirmado únicamente después de un «sí» explícito de la persona al resumen exacto mostrado. Nunca confirmes por inferencia, por silencio ni ante una respuesta ambigua.

### Desde el código

```bash
git clone https://github.com/dfernandezdaw/chiclana-avisos-mcp.git
cd chiclana-avisos-mcp
npm install
npm run build
```

Y apunta tu cliente MCP a `dist/index.js` (por ejemplo, en `claude_desktop_config.json`):

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

## ⚙️ Configuración

Variables de entorno leídas por el proceso MCP:

| Variable | Por defecto | Descripción |
|---|---|---|
| `GECOR_TOKEN` | (vacío) | Token de sesión GECOR. Obligatorio para `list_my_avisos` y para enviar avisos; también identifica al peticionario. |
| `GECOR_AYTO_ID` | `268` | Municipio activo inicial (Chiclana de la Frontera). |
| `GECOR_API_URL` | `https://gecorapiwe.azurewebsites.net/api` | URL base de la API de GECOR. |
| `GECOR_PROCEDENCIA_WEB` | `1390` | Procedencia del aviso cuando la ficha del ayuntamiento en GECOR no incluye `ProcedenciaWeb`. Valores que no sean enteros positivos usan el defecto. |
| `GECOR_LANGUAGE` | `es` | Idioma de las consultas a GECOR (p. ej. listado de municipios). |
| `GECOR_TIMEOUT_MS` | `20000` | Tiempo máximo por petición, en ms. Valores no válidos usan el defecto; el máximo es `120000`. |
| `GECOR_PHOTO_DIRS` | tmp, `~/Downloads`, `~/Pictures`, `~/Desktop`, `~/.hermes` | Directorios permitidos para `image_path`, separados por `:` (`;` en Windows). Solo rutas absolutas; **sustituyen** a los valores por defecto. |
| `GECOR_MAX_PHOTO_BYTES` | `20971520` (20 MB) | Tamaño máximo de la foto recibida. |

---

## 🛠️ Herramientas MCP Disponibles

| Tool | Descripción |
|---|---|
| `whoami` | Muestra el municipio activo y si `GECOR_TOKEN` está configurado. |
| `list_ayuntamientos` | Lista los municipios que usan GECOR, con su `AyuntamientoID` (filtro opcional `search`). |
| `set_ayuntamiento` | Cambia el municipio activo de la sesión MCP (`ayuntamientoID`). |
| `list_categories` | Lista las familias, elementos/subcategorías y tipologías de avería disponibles (admite filtro de texto: ej. `farola`, `basura`). |
| `resolve_location` | Con `lat`+`lng`, devuelve hasta 5 calles cercanas (radio 150 m) con `CalleID` y `Numero`. Con `street_name`, busca en el callejero oficial y devuelve hasta 10 coincidencias (`CalleID`, `Nombre`, `TipoVia`) **sin coordenadas**: no es geocodificación. |
| `create_aviso_from_photo` | Única herramienta pública para avisos: previsualiza con descripción, categoría GECOR, ubicación y una foto obligatoria (`image_path` o `image_base64`, no ambos); procesa EXIF, reduce la foto si procede y devuelve un resumen con `foto` y un `preview_token` válido 10 minutos y de un solo uso, más una miniatura como contenido de imagen para que el agente redacte y verifique la descripción. Sin `description`, devuelve `phase: need_description` con la miniatura y sin token. Tras confirmación explícita, acepta únicamente `preview_token`, `confirm: true` y `human_confirmed: true`. La foto se sube solo en el envío confirmado. |
| `list_my_avisos` | Lista las incidencias registradas por el usuario del token con su estado de tramitación. Es la comprobación obligatoria tras un envío ambiguo. |

---

## 🔒 Seguridad y confirmación explícita

El flujo de envío requiere confirmación explícita; la previsualización por sí sola no crea ningún aviso ni sube la foto, pero confirmarla envía un aviso real al ayuntamiento:

1. Usa `create_aviso_from_photo` para ambas fases. Para previsualizar, envía los campos del aviso y una foto no vacía mediante `image_path` o `image_base64`, sin token ni campos de confirmación. Usa `list_categories` para identificar categorías. La herramienta procesa EXIF internamente durante la previsualización; no existe una herramienta independiente `parse_photo_gps`.
2. Muestra un resumen breve de categoría, descripción, dirección/referencia, foto y ubicación disponible. No incluyas peticionario, tokens, payload crudo ni identidad privada.
3. Espera un sí inequívoco al resumen exacto en la misma conversación. Ante cambios o respuesta ambigua, crea una previsualización nueva y vuelve a pedir confirmación.
4. Tras confirmar, llama al mismo tool solo con `preview_token`, `confirm: true` y `human_confirmed: true`. Haz esta llamada solo tras un «sí» explícito al resumen exacto. Si falla la validación o la subida de la foto, informa que el aviso NO se envió; nunca reintentes una escritura posiblemente completada.
5. `estado: ENVIADO_EXITOSAMENTE` en la respuesta wrapper de Chiclana indica que la llamada MCP/API tuvo éxito, no que ese sea el estado de tramitación municipal. Comunica únicamente lo que devolvió la API: informa un número oficial de ticket o estado de tramitación solo si aparece en `resultado` devuelto por GECOR o está verificado inequívocamente; no lo adivines.

La dirección textual no se geocodifica en este proyecto: `resolve_location` por nombre de calle solo devuelve el `CalleID`. Si la foto no aporta GPS EXIF, solicita coordenadas explícitas; nunca inventes ubicación. Prefiere la foto original para conservar EXIF. No se admite subida remota HTTP.

### Fotos

- Formatos: solo **JPEG** o **PNG**, detectados por su contenido. HEIC no se admite: conviértela antes (en iPhone, Ajustes › Cámara › Formatos › «Más compatible»).
- Tamaño máximo: 20 MB (`GECOR_MAX_PHOTO_BYTES`).
- `image_path` debe estar dentro de los directorios permitidos (`GECOR_PHOTO_DIRS`; por defecto el temporal del sistema, `~/Downloads`, `~/Pictures`, `~/Desktop` y `~/.hermes`) y apuntar a un fichero regular. Si no, usa `image_base64` (admite prefijo `data:image/...;base64,`).
- GPS: solo se lee el EXIF de JPEG. Los PNG, las fotos reenviadas por apps que eliminan metadatos (p. ej. Telegram, salvo envío como archivo) y las capturas no aportan coordenadas.
- Reducción: los JPEG cuyo lado mayor supera 2048 px se reducen a 2048 px (calidad 85) conservando los segmentos EXIF/XMP originales, incluida la orientación. Si la reducción no es posible, se sube el original y la previsualización lo indica en `foto.aviso_reduccion`. Los PNG se suben sin cambios.
- Miniatura: la previsualización devuelve al modelo una imagen JPEG de lado mayor ≤ 1024 px (calidad 80) sin EXIF ni GPS, con la orientación ya aplicada; los PNG de hasta 1 MB se devuelven tal cual y los mayores no tienen miniatura. La miniatura nunca se sube: GECOR recibe la copia de 2048 px con EXIF. Si no se puede generar, la previsualización continúa sin ella.
- La previsualización incluye `foto` con `mime`, `original_bytes`, `upload_bytes`, `width`, `height`, `reducida`, `exif_conservado` y `miniatura` (más `aviso_miniatura` si no se pudo generar).

### Errores y reintentos

- Cada petición a GECOR expira tras `GECOR_TIMEOUT_MS` (20 s por defecto). Las consultas (`get*`) se reintentan una vez ante timeout, error de red o 5xx; las escrituras nunca se reintentan automáticamente.
- El `preview_token` se consume antes de cualquier efecto: un mismo token no puede crear dos avisos.
- Si falla la subida de la foto, no se crea ningún aviso; genera una nueva previsualización.
- Si la creación devuelve «Envío NO confirmado» tras timeout, error de red o 5xx, el resultado es **ambiguo**: el aviso podría haberse creado. Consulta `list_my_avisos` y, solo si no aparece, crea una nueva previsualización y pide confirmación otra vez. Un 4xx sí descarta la creación.

### Skill reutilizable

El artefacto de instrucciones, independiente de cualquier plataforma o harness, está en [`skill/SKILL.md`](skill/SKILL.md). Su instalación es manual: colócalo en el directorio de skills que admita tu cliente. Mantén el proceso MCP en un entorno con acceso a las rutas locales que le proporciones; este proyecto no modifica configuraciones externas.

---

## 🌐 Soporte Multi-Ayuntamiento

Aunque está preconfigurado por defecto para **Chiclana de la Frontera (ID 268)**, el servidor está pensado para los municipios que usan GECOR (Torremolinos, Vélez-Málaga, Viladecans, etc.).

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
node dist/cli.js photo <foto.jpg>         # Inspeccionar metadatos GPS EXIF (misma restricción de directorios)
node dist/cli.js calles [filtro]          # Consultar callejero oficial
```

---

## 🏗️ Construcción y Desarrollo

```bash
npm install
npm run build
npm run typecheck
npm test
```

---

## 📄 Licencia

MIT. Consulta [`LICENSE`](LICENSE).

Inspirado en [madrid-avisos-mcp](https://github.com/Naroh091/madrid-avisos-mcp).
