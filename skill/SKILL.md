---
name: chiclana-avisos
description: "Trigger: aviso Chiclana, incidencia municipal, GECOR. Gestiona avisos con foto mediante herramientas MCP y confirmación segura."
---

## When to Use

Activa esta skill cuando alguien quiera comunicar una incidencia municipal con el MCP de Chiclana.

## Procedure

1. Recibe una foto y una dirección o referencia. La foto es obligatoria para previsualizar; usa `list_categories` para elegir la categoría oficial y aclara cualquier duda antes de continuar.
2. Usa `image_path` solo si el proceso MCP puede leer esa ruta; de lo contrario, usa una imagen en un formato que sí pueda leer, como `image_base64`. No afirmes que una foto tiene GPS sin comprobarlo: `create_aviso_from_photo` procesa EXIF automáticamente durante la previsualización.
3. Si no hay GPS en la foto ni coordenadas proporcionadas por la persona, solicita una ubicación explícita. Nunca inventes coordenadas. La dirección textual por sí sola no sustituye las coordenadas.
4. Usa la única herramienta pública de avisos, `create_aviso_from_photo`, para previsualizar con una foto no vacía en `image_path` o `image_base64`. Presenta un resumen de categoría, descripción y ubicación, sin peticionario, token ni payload crudo.
5. Envía con `create_aviso_from_photo` únicamente después de un sí explícito al resumen exacto, usando solo el `preview_token` de esa previsualización, `confirm: true` y `human_confirmed: true`. La foto queda vinculada a la previsualización y no se repite en la confirmación. Si hay cambios, vuelve a previsualizar y pide confirmación nueva.
6. Informa de ticket o estado solo si GECOR lo devuelve o queda verificado. Si el guard o la API falla, indica claramente que no se envió. Nunca repitas una escritura de resultado ambiguo.

## Pitfalls

- No uses ni inventes coordenadas basándote solo en una dirección.
- No expongas identidad del peticionario, tokens ni payloads crudos.
- No confundas una respuesta técnica de envío correcto con el estado municipal del aviso.
- No reintentes una escritura cuyo resultado sea ambiguo.

## Verification

Antes del envío, comprueba que la persona confirmó explícitamente la previsualización exacta. Tras responder, limita los datos de ticket y estado a los devueltos o verificados por GECOR.
