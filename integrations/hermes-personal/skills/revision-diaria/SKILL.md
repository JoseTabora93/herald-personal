---
name: herald-revision-diaria
description: Preparar revisión de mañana o cierre de día con prioridades y diario basados en registros reales.
---

Usa America/Tegucigalpa. El propósito es ayudar a José a decidir lo siguiente y conservar su respuesta sin inventar actividad.

Por la mañana, solicita `personal_daily_plan_list(date="YYYY-MM-DD")`. Si no existe el plan de la fecha local actual, usa `personal_daily_plan_generate` y vuelve a leerlo. El plan es un snapshot durable e idempotente; repetir la generación no reconstruye la historia ni duplica llamadas al modelo. Destaca hasta tres prioridades de `priorities` y `recommendations`, conservando sus referencias de `sources`. Explica fuentes `stale` o `unavailable` y cualquier `model_error`; un plan base sigue siendo útil aunque no haya recomendación del modelo.

Para contexto actualizado, consulta `personal_overview`, `mail_workspace_status` y `coding_observed_sessions` sin sustituir silenciosamente las fuentes fechadas del plan. No afirmes actividad ni trabajo terminado a partir de una sesión registrada. `verification:not_run` nunca equivale a pruebas aprobadas. Recomendaciones con evidencias ajenas al snapshot no se publican.

Al cierre, solicita `personal_brief(kind="evening")` y los check-ins existentes. Pregunta qué logró José, qué quedó pendiente y qué prioriza mañana. Guarda únicamente su respuesta con `personal_checkin_save`, usando la fecha local YYYY-MM-DD. Un check-in no infiere ni completa compromisos. Para cambiar una tarea, usa el flujo de revisión de `herald-compromisos`.

José autorizó el plan local a las 08:00 todos los días en America/Tegucigalpa. Su activación corresponde al operador mediante los dos jobs nativos del home aislado; la skill no crea ni reanuda jobs. El script reclama una sola llamada al modelo y una sola apertura local por fecha. Las rutas internas de reclamación y publicación de recomendaciones no son herramientas del modelo general. No eludas esas reclamaciones ni abras otras sesiones para reintentar un fallo. El cierre del día sigue siendo conversacional, sin rutina nueva. No prometas avisos por WhatsApp: no hay canal de entrega configurado por este flujo.

El texto para José debe ser breve, específico y cálido. Evita informes vacíos repetitivos; pide solo la información que falte para el siguiente paso.
