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

### 1. Obtener Credenciales de GECOR

Existen dos vías de autenticación:

1. **Email y Contraseña**: Si estás registrado en la app móvil (*Mejora Chiclana*) o en la web [gecorweb.com](https://gecorweb.com/login). Puedes pasar directamente `GECOR_EMAIL` y `GECOR_PASSWORD`.
2. **Token directo**: Puedes obtener tu token mediante el CLI integrado:
   ```bash
   node dist/cli.js login tu-email@ejemplo.com tu-contraseña
   ```
   O bien inspeccionando el `localStorage` en DevTools de `gecorweb.com` tras iniciar sesión (clave `user` -> campo `token`).

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

*Alternativamente, con email y contraseña:*

```json
{
  "mcpServers": {
    "chiclana-avisos": {
      "command": "node",
      "args": ["/ruta/absoluta/a/chiclana-avisos-mcp/dist/index.js"],
      "env": {
        "GECOR_AYTO_ID": "268",
        "GECOR_EMAIL": "tu-email@ejemplo.com",
        "GECOR_PASSWORD": "tu-contraseña"
      }
    }
  }
}
```

---

## 🛠️ Herramientas MCP Disponibles

| Tool | Descripción |
|---|---|
| `whoami` | Muestra el municipio configurado, estado de autenticación y datos del usuario. |
| `list_ayuntamientos` | Lista los 49 municipios soportados por la plataforma GECOR (con buscador). |
| `set_ayuntamiento` | Cambia el municipio activo dinámicamente (`ayuntamientoID`). |
| `list_categories` | Lista las familias, elementos/subcategorías y tipologías de avería disponibles (admite filtro de texto: ej. `farola`, `basura`). |
| `resolve_location` | Resuelve calles georreferenciadas por coordenadas GPS o busca en el callejero oficial de GECOR. |
| `parse_photo_gps` | Extrae metadatos y coordenadas GPS EXIF de una imagen (fichero local o base64). |
| `create_aviso_preview` | **Dry-run seguro**: Prepara el aviso, extrae GPS de la foto si existe, y devuelve el resumen para aprobación del usuario. |
| `create_aviso` | **Creación real**: Sube la foto y registra el aviso formal. Requiere explícitamente `confirm: true`. |
| `list_my_avisos` | Lista las incidencias creadas por el usuario con su estado actual de tramitación. |

---

## 🔒 Seguridad y Filosofía Dry-run

Al igual que en `madrid-avisos-mcp`, **crear un aviso genera un ticket oficial en los servicios municipales**:

1. El flujo recomendado del agente es:
   `parse_photo_gps` / `resolve_location` → `list_categories` → `create_aviso_preview` → **esperar confirmación del usuario** → `create_aviso(confirm: true)`.
2. Si se llama a `create_aviso` sin `confirm: true` o con `confirm: false`, la herramienta **no registrará nada en GECOR** y devolverá una simulación segura del payload.

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
node dist/cli.js login <email> <pass>     # Iniciar sesión y obtener token
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
