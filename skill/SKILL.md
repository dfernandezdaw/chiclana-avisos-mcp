---
name: chiclana-avisos
description: "Trigger: aviso Chiclana, incidencia municipal, reportar desperfecto por Telegram, GECOR. Gestiona avisos con foto mediante el MCP de Chiclana y confirmación segura."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## Activation Contract

Activa esta skill cuando una persona quiera comunicar un desperfecto en Chiclana mediante Telegram y el MCP `chiclana-avisos` esté disponible.

## Hard Rules

- Recibe una foto de Telegram y una dirección o referencia escrita. Prefiere la foto original/documento para conservar EXIF; nunca afirmes que la foto tiene GPS sin comprobarlo. Si usas `parse_photo_gps`, usa solo `gps` y nunca muestres EXIF `make`, `model` ni `takenAt`.
- Usa `list_categories` para elegir IDs GECOR. Pregunta si categoría o descripción no están claras; no inventes.
- La dirección escrita no se geocodifica en este proyecto. Si EXIF no aporta GPS, pide un pin de ubicación de Telegram o coordenadas explícitas. Nunca inventes coordenadas.
- Usa `image_path` solo si el proceso MCP puede acceder a la ruta local de la foto de Telegram. No hay subida remota HTTP. Si no, usa la foto mediante un medio admitido por el MCP, como `image_base64`.
- No muestres `peticionario`, tokens, payload crudo ni datos privados de identidad.

## Decision Gates

| Situación | Acción |
| --- | --- |
| Categoría o descripción incierta | Pregunta antes de previsualizar |
| Sin GPS EXIF ni ubicación explícita | Solicita pin o coordenadas; no llames aún |
| Cambio o respuesta ambigua | Crea previsualización nueva y solicita confirmación otra vez |
| Guard deshabilitado o fallo en envío | Di claramente que NO se envió; no eludas el guard ni reintentes una escritura posiblemente completada |

## Execution Steps

1. Obtén la foto y dirección/referencia. Comprueba GPS EXIF; consulta `list_categories` y aclara dudas.
2. Llama primero `create_aviso_from_photo` con descripción, IDs/nombres de categoría, ubicación disponible y foto; no incluyas `preview_token`, `confirm` ni `human_confirmed`.
3. Presenta un resumen conciso con categoría, descripción, dirección/referencia, foto y ubicación disponible. No expongas identidad ni datos internos.
4. Espera en la misma conversación de Telegram un sí inequívoco para ese resumen exacto. Cualquier cambio requiere nueva previsualización.
5. Solo tras ese sí, llama al mismo tool con exactamente `preview_token`, `confirm: true` y `human_confirmed: true`.
6. Tras el resultado, `estado: ENVIADO_EXITOSAMENTE` solo significa que la llamada MCP/API tuvo éxito, no que ese sea el estado de tramitación municipal. Informa un número oficial de ticket o estado de tramitación solo si aparece en `resultado` devuelto por GECOR o está verificado inequívocamente; nunca adivines.

## Output Contract

Comunica el resultado real del envío (o que NO se envió), sin revelar datos privados, tokens ni payload interno.

## References

- `../README.md` — contrato MCP e instalación manual.
