# Chat por proyecto

En **Personal → Proyectos**, selecciona un proyecto y pulsa **Conversar con Hermes**.
La ventana conserva su propio historial; cambiar de proyecto no cambia el chat principal.
Las sugerencias preparan un borrador. Enter envía y Mayús+Enter añade una línea. Puedes
detener la respuesta, minimizar la ventana o retomar una conversación del selector.

Hermes recibe un identificador de proyecto y consulta su estado mediante
`personal_project_context`. Los registros y los resultados de fuentes externas se tratan
como datos, no como instrucciones. Las respuestas y resultados de herramientas usan el
mismo gateway, controles de aprobación e historial de Hermes que el chat principal.

Al pedir un cambio de rumbo, Hermes puede guardar una instrucción mediante
`personal_project_direction_update`. La revisión evita sobrescribir otra decisión y su
historial es durable. **Guardar el rumbo en Herald no confirma su entrega a un agente
externo.** No modifica la evidencia de ejecución ni los estados recibidos de GitHub. El
sincronizador no puede borrar esa instrucción al actualizar las tareas importadas.

Los compromisos locales se crean o editan con las herramientas personales existentes.
Para ejecutar desarrollo, Hermes solo dispone de los alcances que el operador haya
habilitado en el supervisor. Observar una sesión de Claude Code/OpenCode o recibir un
snapshot de un VPS no crea un canal para enviarle instrucciones.

## Persistencia y contrato

La migración SQLite 5 es aditiva: enlaces de conversación, rumbo y eventos de decisión.
El texto de las conversaciones sigue en el almacén de Hermes. No se duplica en el servicio
personal. Un enlace de sesión es idempotente y no puede pertenecer a dos proyectos.

| Método y ruta | Uso |
| --- | --- |
| `GET /v1/projects/{id}/workspace` | Evidencia, conversaciones vinculadas, rumbo y últimas decisiones |
| `POST /v1/projects/{id}/conversations` | Vincular `{session_id,title}` después de crear una sesión Hermes |
| `PUT /v1/projects/{id}/direction` | Guardar `{text,expected_revision}`; 409 exige releer |

Todas las rutas requieren el bearer del servicio. Las credenciales permanecen en Electron
main o en el puente MCP. El renderer solo puede consultar el espacio y vincular sesiones.
La escritura del rumbo se realiza desde la herramienta autenticada de Hermes. Su resultado
incluye `delivery: local`; no representa un envío externo.

Abrir una ventana vacía no crea sesión ni llama un modelo. El primer envío crea y vincula
la sesión antes de presentar el prompt. Ante un fallo al vincular, se conserva esa misma
sesión para reintentar. Un fallo al retomar historial nunca crea un reemplazo silencioso.
Los borradores se conservan por conversación mientras la aplicación está abierta; el
historial enviado sí sobrevive al reinicio. No hay reintentos automáticos de prompts.

## Verificación reproducible

- Vitest: `src/store/chat.test.ts`, `src/features/personal/project-chat*.test.ts` y
  `electron/personal/client.test.ts`.
- Pytest: `tests/test_project_workspace.py`, además de pruebas de migración y autorización.
- Puente: `integrations/hermes-personal/tests/test_project_workspace.py`.
- Con el escritorio compilado, `node scripts/qa-project-chat-electron.mjs` usa Electron,
  IPC, API y persistencia Hermes reales dentro de un perfil desechable. Intercepta
  `prompt.submit` para simular deltas, errores y resultados; no llama un modelo real ni
  envía órdenes a agentes. El historial del recorrido se siembra mediante el gateway real.

Esta QA valida transporte, interfaz, persistencia y herramientas. La calidad de las
respuestas depende del proveedor configurado; la QA no evalúa un modelo externo ni
demuestra control de sesiones remotas.
