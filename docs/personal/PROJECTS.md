# Seguimiento por proyecto

Personal → Proyectos reúne todos los compromisos con un nombre de proyecto,
incluidos los cerrados. Permite seleccionar proyecto y tarjeta, consultar el PR
dentro de Herald, abrir el compromiso y ver el historial de cambios.

El tablero separa tres hechos: estado de ejecución, estado del PR e integración,
y verificación funcional/despliegue. Una ejecución terminada sin PR queda por
atender. Un PR abierto queda en revisión. Un merge cierra el compromiso de
integración, pero nunca certifica pruebas o despliegue. Los compromisos manuales
se muestran con su estado local.

## Contrato compartido

- `GET /v1/projects`: proyectos, tarjetas, conteos, eventos, fuentes y vigencia.
- `PUT /v1/project-sources/{source_id}`: ingestión autenticada y atómica del
  inventario de un origen. Contrato Pydantic en `herald_personal/projects.py`.
- Hermes: `personal_project_list`, de solo lectura, usa el mismo endpoint.
- El renderer puede leer proyectos. No puede escribir inventarios de orígenes.

La migración SQLite 3 → 4 agrega `project_sources` y `project_items` conservando
IDs e historial. La primera sincronización puede adoptar tareas `agent` previas
por su `source_id`, únicamente dentro del mismo proyecto y sin otro propietario.
El origen administra título, descripción, prioridad y estado de estas tareas;
la fecha de vencimiento se conserva. Cada cambio real genera un evento; repetir
la consulta no duplica tareas ni eventos. Se rechazan consultas anteriores y una
misma fecha de consulta con contenido distinto.

## Adaptador de inventarios de construcción

`python -m herald_personal.project_sync /ruta/privada/project.json` lee una fuente
HTTPS y GitHub, y publica un snapshot en la API local. No ejecuta agentes ni
modifica repositorios. El archivo de configuración debe pertenecer al usuario y
tener permisos 0600. Incluye referencias a archivos de credenciales, nunca sus
valores. Ejemplo de estructura (ajustar rutas y recursos propios):

```json
{
  "source_id": "example-build",
  "project": "Mi proyecto",
  "label": "Constructor + GitHub",
  "status_url": "https://build.example.com/status.json",
  "status_username": "viewer",
  "status_password_file": "/ruta/privada/source-password",
  "repository": "example/project",
  "gh_path": "/ruta/absoluta/gh",
  "connection_file": "/ruta/privada/connection.json",
  "interval_seconds": 900,
  "tracked_prs": [22],
  "tracked_work": [{"key": "phase-one", "title": "Fase 1"}],
  "run_metadata": {
    "run-example": {"title": "Importador", "branch": "feat/importer"}
  },
  "coverage_notes": ["Este origen cubre solamente el inventario de construcción."]
}
```

La fuente entrega `generado` (ISO 8601 con zona), `runs` y opcionalmente
`problemas`. Cada run incluye `id`, `nombre`, `status`, opcionalmente `branch` y
`pr` (lista de números). Los nombres/ramos configurados sustituyen los del
inventario, útil para PRs abiertos fuera del constructor. Los PRs indicados en
`tracked_prs` aparecen aun sin una ejecución vinculada. Consultar un PR no
demuestra que exista una sesión activa.

`tracked_work` mantiene visibles trabajos solicitados cuyo origen todavía no
exporta una ejecución. Se muestran sin ejecución confirmada. Si se conoce la
rama, puede indicarse `branch` para consultar su PR; nunca se inventa un run.

La ruta de `gh` es absoluta para funcionar desde launchd. La consulta tiene un
timeout de 30 s. Un inventario de 200 PRs se considera incompleto y no se usa
para inferir ausencia; en ese caso se conserva la última evidencia y se informa
consulta parcial. Las lecturas HTTP son acotadas y no siguen redirecciones con
credenciales. Los errores públicos son códigos fijos sin diagnósticos remotos.

## Vigencia y fallos

El panel consulta su API cada 15 s mientras está visible. El sincronizador
consulta las fuentes según su horario existente; el panel muestra ese intervalo
y la última consulta. No deben confundirse ambas frecuencias.

Una señal vence tras dos intervalos más 60 s. Tanto servidor como renderer dejan
de mostrar una ejecución activa vencida. Una fecha sin zona, futura o ausente no
demuestra actividad. Una falla preserva los últimos PRs y tareas; una ejecución
que desaparece del inventario queda sin confirmar, nunca se elimina ni se da por
terminada. Los estados de PR conservados muestran la fecha de su comprobación.
Un origen local requiere que la Mac y el servicio estén activos.

## Verificación de esta entrega

- RED: endpoints ausentes, controlador ausente; navegación ausente, señal vencida;
  conflicto de consultas simultáneas y conservación de PRs ante fallos parciales.
- Python: persistencia tras reinicio, migración 3 → 4, autenticación, aislamiento
  entre proyectos/orígenes, idempotencia, vigencia, privacidad y transporte.
- Escritorio: controlador y comandos, selección y URLs acotadas de GitHub.
- `node scripts/qa-projects-electron.mjs`: Electron, IPC, API y SQLite reales con
  datos sintéticos; tablero, detalle, selección entre proyectos, actualización,
  reinicio y falla de origen. No conecta correo ni ejecuta agentes.

Los resultados de instalación y capturas de proyectos privados se conservan
fuera del repositorio publicado.
