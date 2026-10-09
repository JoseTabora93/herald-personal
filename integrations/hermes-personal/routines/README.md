# Plan diario y observación local

Dos jobs nativos Hermes: plan diario a las **08:00 todos los días**, zona **America/Tegucigalpa**, y observación de sesiones cada cinco minutos. `templates.json` es un manifiesto de instalación pausado; no se copia al almacén privado de cron. La sincronización de Ingelmec Mail pertenece a su aplicación y no necesita otro job Hermes.

## Configuración e instalación

Usar el home personal instalado, fuera de `~/.hermes`. Sustituir las rutas de ejemplo por las del usuario que instalará el servicio.

```bash
export HERALD_BASE="$HOME/Library/Application Support/Herald Personal"
export HERMES_HOME="$HERALD_BASE/hermes-home"
export HERMES_TIMEZONE=America/Tegucigalpa
```

1. Instalar `src/herald_hermes` en `$HERALD_BASE/lib/herald_hermes`. El servicio y el MCP configuran `PYTHONPATH`; los dos wrappers cron resuelven explícitamente la biblioteca de su instalación, sin depender del entorno de la terminal. No modifican dependencias.
2. Copiar los dos archivos `routines/scripts/*.py` a `$HERMES_HOME/scripts/`.
3. Crear `$HERALD_BASE/observer.json` a partir de `observer.example.json` y `$HERMES_HOME/herald_jobs.json` a partir de `herald_jobs.example.json`, ambos propiedad del usuario y modo `0600`. Las credenciales se referencian por ruta; nunca se copian sus valores al JSON.
4. En `herald_jobs.json`, usar `owner: herald-personal`, la zona indicada, el home real, URL personal `http://127.0.0.1:8787`, el archivo de token personal existente, ruta absoluta a Hermes y `$HOME/Applications/Herald Personal.app`. `model_enabled: true` habilita una única llamada acotada por fecha con el proveedor configurado en ese home; `false` conserva el plan base y registra `not_configured`. `model_label` identifica el modelo realmente configurado en el perfil.

El observador utiliza `claude agents --json` y la API local de OpenCode v2. Configurar exclusivamente directorios del usuario como alcances de metadatos; la ruta más específica determina el alias. Las credenciales de OpenCode se leen en memoria desde su archivo privado existente y sólo se usan con endpoints GET en loopback. No se leen conversaciones.

Antes de registrar jobs, revisar `hermes cron list --all` **con este mismo HERMES_HOME**. Reutilizar los IDs con los nombres propios siguientes; no crear duplicados. Los comandos generan jobs pausados que root activa después de verificar la instalación:

```bash
"$HOME/.local/bin/hermes" cron create '0 8 * * *' \
  --name herald-personal-daily-plan --script herald_daily_plan.py --no-agent \
  --interpreter "$HERALD_BASE/.venv/bin/python" --deliver local \
  --paused --paused-reason 'Validación local'

"$HOME/.local/bin/hermes" cron create '*/5 * * * *' \
  --name herald-personal-session-observer --script herald_observer.py --no-agent \
  --interpreter "$HERALD_BASE/.venv/bin/python" --deliver local \
  --paused --paused-reason 'Validación local'
```

Conservar los dos IDs devueltos en el registro privado de instalación. Revisar cada job y reanudar exclusivamente esos IDs mediante `hermes cron resume ID`. Las propuestas anteriores de mañana 07:00, cierre, seguimiento y revisión cada quince minutos fueron sustituidas; no forman parte de esta activación.

## Gateway, reinicio y ownership

El código oficial instalado acepta cero plataformas de mensajería y mantiene cron en ejecución (`gateway/run_startup.py`). No habilitar canales para hacer funcionar estos jobs.

```bash
"$HOME/.local/bin/hermes" gateway install --if-missing --no-start-now
# Verificar que el servicio pertenece a este HERMES_HOME antes de iniciarlo.
"$HOME/.local/bin/hermes" gateway start
```

El helper oficial deriva un label `ai.hermes.gateway-<hash-del-home>` y su plist propio bajo `~/Library/LaunchAgents`. Verificar el valor calculado por la versión instalada. El servicio global `ai.hermes.gateway` tiene otro propietario. No usar `--all`, `--force` ni `--replace`. Hermes arbitra el scheduler entre gateway y servidor web; no editar sus bases ni archivos de ownership.

En el `config.yaml` **aislado**, el operador puede establecer:

```yaml
cron:
  script_timeout_seconds: 120
  catch_up_missed: true
```

La implementación oficial inspeccionada recupera una ocurrencia atrasada y recalcula la siguiente; no reproduce todos los intervalos perdidos. `catch_up_missed: false` omite ocurrencias demasiado atrasadas. Un Mac dormido o apagado no ejecuta el job exactamente a las 08:00: al volver, la recuperación prepara la fecha local actual. El ledger nativo evita repetir la misma ocurrencia; las reclamaciones del API impiden repetir la llamada al modelo y la apertura aun si se vuelve a ejecutar el script.

## Verificación local

Root puede ejecutar estas validaciones explícitas con la instalación configurada. El observador solo lee metadatos y persiste snapshots en el API personal; el comando diario siguiente no abre la app, pero sí genera el plan y, si `model_enabled` es true, consume su reclamación del modelo.

```bash
PYTHONPATH="$HERALD_BASE/lib" "$HERALD_BASE/.venv/bin/python" -m herald_hermes.daily_jobs observer \
  --config "$HERMES_HOME/herald_jobs.json"

PYTHONPATH="$HERALD_BASE/lib" "$HERALD_BASE/.venv/bin/python" -m herald_hermes.daily_jobs daily \
  --config "$HERMES_HOME/herald_jobs.json" --no-open
```

Un smoke contra la fecha real consume la llamada diaria. Usar fixtures/servicio aislado para probar repeticiones y fallos. La apertura real usa `/usr/bin/open -a APP --args --personal-plan YYYY-MM-DD`; éxito del comando no acredita por sí solo inspección visual de la ventana.

La plantilla conserva `model_enabled: false`. Antes de habilitarlo, el operador debe autorizar el proveedor concreto y el envío del snapshot: prioridades de compromisos, fuentes, conteos de correo, estados de agentes y limitaciones. No contiene cuerpos de correo ni conversaciones de los agentes. Mantenerlo desactivado conserva la preparación y apertura local del plan.

## Contratos y límites

El observador publica `PUT /v1/agent-observations/{observer_id}` con ID estable, revisión monotónica, agente, ID nativo, alias, estado, confianza, fuente, tiempos y señales normalizadas. El API calcula `effective_status: unknown` después de diez minutos sin observación. Claude usa estados explícitos del inventario CLI. OpenCode usa `/api/session/active` y consultas de permisos/preguntas por sesión; una señal no soportada queda declarada. Ausencia del mapa activo significa inactividad en esa fotografía, no trabajo terminado. La página reciente se limita a cincuenta registros y se recuperan metadatos de hasta veinte sesiones activas adicionales.

No se leen endpoints de mensajes ni archivos de conversación. No se publican nombres de sesiones, directorios, PID, prompts, comandos, salida ni tokens. La allowlist se aplica antes de consultar detalles de permisos. Un proceso existente o una modificación de archivo, sin señal explícita del ejecutor, no demuestra actividad ni espera de aprobación. Un error del proveedor deja envejecer su última observación, sin falsear un estado sano.

El plan base se genera idempotentemente en `POST /v1/daily-plans/generate`. El script reclama `model-claim` justo antes de invocar Hermes: presupuesto de 45 segundos/una vuelta, límite externo de 60 segundos y 256 KiB de salida. Usa `--toolsets todo` explícito: la versión verificada resuelve únicamente `todo_list` y excluye terminal/MCP. La entrada contiene el snapshot del plan, no correo ni conversaciones completas. Solo se acepta el envelope final `result` con JSON válido y referencias existentes de `sources`. Si falla, conserva el plan base y registra un enum de error; no reintenta automáticamente.

`open-claim` se reclama justo antes de abrir la app y no se recupera automáticamente tras crash. Esto evita abrir dos veces; una reclamación sin apertura requiere inspección humana. Las recomendaciones y aperturas no completan tareas ni modifican las sesiones observadas. Todas las observaciones mantienen `verification: not_run`.

El MCP general incorpora `mail_workspace_status/query/capture`, `personal_daily_plan_generate/list` y `coding_observed_sessions`. El modelo general no recibe rutas de reclamación, apertura ni publicación de recomendaciones. El workspace de correo conserva la autoridad sobre cada `MAIL-n`; capturar un compromiso enlaza su identidad en el API personal.

## Evidencia y fuentes

La suite usa servidores HTTP locales, procesos temporales y fixtures; no hace llamadas de pago ni controla sesiones reales. Ver [VERIFICATION.md](../VERIFICATION.md) para RED/GREEN y resultados. La inspección de CLI/API reales acredita la superficie de lectura, no la activación cron ni la entrega de recomendaciones del modelo. Root registra la instalación y activación en la validación del despliegue.

Fuentes primarias: [Hermes cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron), ayuda y código local de Hermes, [Claude hooks](https://code.claude.com/docs/en/hooks), [OpenCode v2 sesiones activas](https://dev.opencode.ai/v2/docs/api/session/v2-session-active/), [listado de sesiones](https://dev.opencode.ai/v2/docs/api/session/v2-session-list/) y [permisos por sesión](https://dev.opencode.ai/v2/docs/api/permission/v2-session-permission-list/). Hooks globales y control de sesiones no están instalados por esta integración.
