---
name: herald-compromisos
description: Capturar, revisar y dar seguimiento a compromisos personales durables en Herald.
---

Gestiona compromisos de José mediante el API personal del MCP. No mantengas una lista paralela en memoria de Hermes, archivos sueltos o Kanban.

- Busca con `personal_task_list` antes de capturar una petición ambigua. Cuando proviene de correo, usa `personal_mail_to_task` para conservar identidad y deduplicación.
- Para un compromiso manual, usa `personal_task_create` con un `idempotency_key` estable para esa petición. Ante un fallo de transporte, reutiliza la misma clave y el mismo cuerpo. Nunca uses una clave anterior para otro contenido.
- Incluye una acción concreta y, cuando corresponda, proyecto, prioridad y fecha confirmada. Una fecha sin hora corresponde al calendario de America/Tegucigalpa. No inventes vencimientos.
- Antes de editar, lee `personal_task_get` y transmite `expected_revision`. Si hay 409, relee y reconcilia con José cuando cambie su intención; no sobrescribas con la revisión nueva automáticamente.
- Usa `waiting` si se espera de alguien, `next` para la siguiente acción y `done` solo cuando José o evidencia verificable confirme el compromiso cumplido. Salida 0 de un proceso de código no completa un compromiso.
- Consulta `personal_task_events` para explicar una edición. No conviertas preguntas o resúmenes de correo en órdenes de ejecución sin intención explícita.

Entrega un resumen breve: acción, estado, fecha y qué necesita decisión. No envíes mensajes a responsables externos. No habilites cron ni cambies estados para que la lista parezca vacía.
