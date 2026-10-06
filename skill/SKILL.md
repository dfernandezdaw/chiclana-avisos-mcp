---
name: chiclana-avisos
description: "Trigger: aviso Chiclana, incidencia municipal, GECOR. Gestiona avisos con foto mediante herramientas MCP y confirmación segura."
---

## When to Use

Activa esta skill cuando alguien quiera comunicar una incidencia municipal con el MCP de Chiclana o consultar el estado de sus avisos.

## Procedure

0. Opcional: `whoami` indica el municipio activo y si hay `GECOR_TOKEN` (`autenticado`). Usa `list_ayuntamientos` y `set_ayuntamiento` solo si la incidencia no es de Chiclana (municipio por defecto, ID 268).
1. Para preguntas de estado («¿cómo va mi aviso?»), usa `list_my_avisos` y responde solo con lo que devuelva.
2. Para un aviso nuevo, recibe una foto y una dirección o referencia. La foto es obligatoria para previsualizar. Usa `list_categories` (con `search`, p. ej. `farola`) para obtener `tipoElementoID`/`tipoIncID` oficiales; aclara cualquier duda antes de continuar.
3. Foto: pasa `image_path` o `image_base64`, nunca ambos.
   - `image_path` debe estar dentro de las carpetas permitidas: temporal del sistema, `~/Downloads`, `~/Pictures`, `~/Desktop`, `~/.hermes`, o las definidas en `GECOR_PHOTO_DIRS` (que sustituyen a las anteriores). Si está fuera, usa `image_base64`.
   - Solo JPEG o PNG, máximo 20 MB (salvo `GECOR_MAX_PHOTO_BYTES`). HEIC no se admite: pide convertirla (iPhone: Ajustes › Cámara › Formatos › «Más compatible»).
   - Solo de los JPEG se lee el GPS EXIF; los PNG nunca aportan coordenadas.
   - Telegram comprime las fotos y elimina EXIF/GPS: pide que la envíen como archivo/documento o que compartan un pin de ubicación.
4. Ubicación: `create_aviso_from_photo` usa el GPS EXIF si la foto lo trae y no se pasan `lat`/`lng`. Sin GPS ni coordenadas de la persona, pide una ubicación explícita (pin o lat/lng). Nunca inventes coordenadas.
   - `resolve_location` con `street_name` busca en el callejero y devuelve solo `CalleID`, `Nombre` y `TipoVia`, **sin coordenadas**: úsalo para rellenar `calleID`/`desUbicacion`, nunca como geocodificación.
   - `resolve_location` con `lat`+`lng` devuelve hasta 5 calles cercanas (radio 150 m) con `CalleID` y `Numero`, útil para `calleID`/`numCalle`/`desUbicacion`.
   - Sin calle resuelta, usa `calleID: 0`.
5. Descripción a partir de la foto: la previsualización devuelve una miniatura (imagen ≤ 1024 px sin EXIF). Si aún no tienes descripción, llama a `create_aviso_from_photo` con la foto y sin `description`: responde `phase: need_description` con la miniatura, sin `preview_token` y sin tocar GECOR. Mira la imagen y redacta 1–2 frases factuales en español con lo visible y lo que diga la persona: elemento, daño y dónde está dentro de la imagen. No inventes medidas, peligro, antigüedad ni causas que no se vean. Si el daño no está claro, pregunta antes de redactar. Después vuelve a previsualizar con `description`.
6. Previsualiza con `create_aviso_from_photo`, sin `preview_token` ni campos de confirmación. Mira la miniatura y comprueba que la categoría y la descripción coinciden con lo visible; si no, corrige y vuelve a previsualizar. Presenta un resumen de categoría, descripción (siempre, para que la persona la confirme) y ubicación, sin peticionario, token ni payload crudo. El campo `foto` (`reducida`, `exif_conservado`, `upload_bytes`, `aviso_reduccion`) solo se menciona si es relevante: las fotos JPEG con lado mayor de más de 2048 px se reducen a 2048 px conservando el EXIF; si aparece `aviso_reduccion`, se subirá el original. Comunica también `aviso_foto` si indica que no hay EXIF legible.
7. Confirmar envía un aviso real al ayuntamiento. Envía con `create_aviso_from_photo` únicamente después de un sí explícito al resumen exacto (nunca por inferencia, silencio o respuesta ambigua), pasando solo `preview_token`, `confirm: true` y `human_confirmed: true`. La foto queda vinculada a la previsualización (caduca a los 10 minutos y es de un solo uso) y no se repite. Si hay cambios o caducó, vuelve a previsualizar y pide confirmación nueva.
8. Informa de ticket o estado solo si GECOR lo devuelve en `resultado` o queda verificado. Si el error es de validación o de subida de foto, indica claramente que no se envió.
9. Si el error dice «Envío NO confirmado» o «ambiguo», el aviso podría existir: consulta primero `list_my_avisos`. Solo si no aparece, crea una nueva previsualización y pide confirmación otra vez. Nunca reenvíes a ciegas.

## Pitfalls

- `resolve_location` por nombre de calle no geocodifica: no derives coordenadas de una dirección.
- No expongas identidad del peticionario, tokens ni payloads crudos.
- `estado: ENVIADO_EXITOSAMENTE` es éxito técnico de la llamada, no el estado municipal del aviso.
- No reintentes una escritura ambigua sin comprobar antes `list_my_avisos`.
- Fotos HEIC, reenviadas por Telegram o en PNG llegan sin GPS útil.
- La descripción la redactas tú a partir de lo visible en la miniatura y de lo que diga la persona; no añadas datos que no se vean ni copies suposiciones como hechos.
- Si la miniatura contradice la categoría elegida (p. ej. se ve un contenedor y la categoría es de alumbrado), no la fuerces: corrígela o pregunta.
- Si la foto no deja claro el daño, pregunta en lugar de adivinar.
- `phase: need_description` no es un error ni una previsualización: no hay `preview_token` que confirmar.
- Si `foto.miniatura` es `false` (p. ej. PNG de más de 1 MB o JPEG no decodificable), no hay imagen: redacta solo con lo que diga la persona y pídele que confirme.

## Verification

Antes del envío, comprueba que la persona confirmó explícitamente la previsualización exacta. Tras responder, limita los datos de ticket y estado a los devueltos o verificados por GECOR; tras un error ambiguo, verifica con `list_my_avisos` antes de cualquier nueva previsualización.
