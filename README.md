# chiclana-avisos-mcp (GECOR Avisos MCP)

Servidor **Model Context Protocol (MCP)** para gestionar avisos e incidencias municipales en **Chiclana de la Frontera (Cádiz)** y cualquier municipio soportado por la plataforma **GECOR**.

Inspirado en el diseño y patrones de seguridad de [madrid-avisos-mcp](https://github.com/Naroh091/madrid-avisos-mcp).

Permite que un agente de IA pueda:
- Interpretar el lenguaje natural del usuario ("Hay una farola rota frente al nº 23 de la Calle Ancha").
- Obtener automáticamente las coordenadas **GPS de los metadatos EXIF de una fotografía** adjunta o geolocalizar por dirección.
- Determinar la categoría y tipología oficial de avería de GECOR.
- Validar el callejero oficial municipal.
- Previsualizar el aviso en modo **dry-run**.
- Registrar formalmente la incidencia ante el Ayuntamiento mediante confirmación explícita (`confirm: true`).
- Consultar el histórico y estado de tramitación de incidencias.

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
| `create_aviso_preview` | **Primera fase obligatoria, dry-run**: valida y congela la propuesta (incluidos los datos del peticionario); no sube fotos ni registra nada. Devuelve el resumen y `preview_token`. |
| `create_aviso` | **Segunda fase**: solo registra el contenido exacto de una previsualización vigente tras aprobación explícita (`confirm: true`, `human_confirmed: true` y `preview_token`). |
| `list_my_avisos` | Lista las incidencias creadas por el usuario con su estado actual de tramitación. |

---

## 🔒 Seguridad y Filosofía Dry-run

Al igual que en `madrid-avisos-mcp`, **crear un aviso genera un ticket oficial en los servicios municipales**:

1. El flujo es siempre de dos fases:
   `parse_photo_gps` / `resolve_location` → `list_categories` → `create_aviso_preview` → mostrar el resumen al usuario.
2. Si el usuario pide un cambio o ajuste, vuelve a llamar `create_aviso_preview` con la propuesta corregida y muestra el nuevo resumen. Cada previsualización se guarda solo en memoria del servidor, vence a los 10 minutos y su token es de un solo uso.
3. Solo después de un **sí explícito** al resumen exacto, llama `create_aviso` con `preview_token`, `confirm: true` y `human_confirmed: true`. Esta herramienta no acepta campos editables del aviso: envía exactamente el payload congelado en esa previsualización. La foto solo se sube en esta fase.
4. Sin confirmación, con un token vencido o reutilizado, no se registra nada. Si la llamada final falla después de consumir el token, genera una nueva previsualización y vuelve a pedir aprobación; no reintentes el token anterior.

### Identidad y ubicación en la previsualización

- El MCP obtiene `Nombre`, `Email`, `Movil` y `CiudadanoID` de claims permitidas del `GECOR_TOKEN`, y los muestra en el resumen para que se revisen antes de autorizar. Si falta un dato o el token no contiene un formato reconocido, la previsualización falla de forma cerrada; no inventa valores ni usa datos de contacto vacíos. El token y los claims completos no se registran ni se muestran.
- Para una dirección elegida en el mapa, pasa la dirección formateada en `desUbicacion`, además de latitud, longitud y número de portal cuando estén disponibles. El envío mapea latitud a `x` y longitud a `y`; `calleID: 0` es válido cuando no hay un ID del callejero GECOR. `resolve_location` es una ayuda independiente y puede no devolver coincidencias.

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
