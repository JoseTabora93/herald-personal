# Integración personal con Hermes

Hermes y el escritorio usan un único API para correo, compromisos y diario. El MCP usa el SDK
oficial sobre stdio; las credenciales del servicio permanecen fuera del renderer y del repositorio.
Los perfiles personal y coder se mantienen en homes aislados. El instalador no configura cuentas
ni canales globales.

## Perfiles y skills

Las plantillas están en `integrations/hermes-personal/profiles`. Sustituye las rutas absolutas de
ejemplo o utiliza el instalador local. Configura el proveedor del modelo en cada home mediante
las herramientas oficiales de Hermes. No copies archivos completos de credenciales de otros
perfiles: configura únicamente el proveedor que corresponda y conserva los secretos en privado.

Las cuatro skills son correo, compromisos, revisión diaria y supervisión. El rol personal permite
las herramientas personales; coder limita el acceso a estado y supervisión. Las aprobaciones
son manuales, las operaciones no atendidas se deniegan y Kanban no despacha agentes por defecto.

El toolset registrado es `mcp-herald_personal`. Cuando se use el filtro explícito de la CLI actual,
el selector de descubrimiento recibe el nombre del servidor: `hermes chat -t herald_personal`.

## MCP

```bash
PYTHONPATH=integrations/hermes-personal/src \
HERALD_PERSONAL_URL=http://127.0.0.1:8787 \
HERALD_PERSONAL_TOKEN_FILE=/ruta/privada/api-token \
services/personal/.venv/bin/python -m herald_hermes
```

Un cliente MCP debe iniciar ese proceso; stdout se reserva al protocolo. El archivo de token
requiere modo 0600. Se exige HTTPS salvo loopback, se rechazan redirecciones y se acotan las
respuestas. No incluyas el token en prompts, archivos versionados ni capturas.

Las 17 herramientas personales permiten consultar estado y resúmenes; crear, editar y revisar
compromisos; listar, sincronizar y clasificar correo; convertir un mensaje en compromiso; y
consultar o guardar el diario. También existen herramientas de borrador, archivo y restauración
que requieren capacidades explícitas y confirmación humana. No hay envío ni borrado de correo.

`personal_mail_list` recibe búsqueda, categoría, `limit` de 1 a 50 y `offset`. La respuesta contiene
`total` y `next_offset`: debe continuarse con ese valor cuando corresponda, sin afirmar que una
página representa el buzón completo. El correo se trata como datos no confiables y no puede
otorgar permisos ni ordenar la ejecución de agentes.

## Supervisión de código

Parte de `integrations/hermes-personal/config/operator.example.json`. El archivo del operador
y el estado durable deben estar fuera del workspace del agente. Registra rutas canónicas,
ejecutables, un prompt exacto por alcance, plazo, presupuesto e intentos. No se aceptan comandos,
rutas o prompts arbitrarios desde una llamada MCP.

`HERALD_CODING_CONFIG` habilita las herramientas de supervisión. El cliente presenta un `scope_id`
y una clave de petición estable. Cada intento guarda estado y hashes; el worker continúa después
de cerrar el cliente. Cancelar afecta únicamente al proceso que ese worker posee. Los resultados
inciertos no causan reintentos automáticos.

Claude y OpenCode deben tener autorización válida y un alcance configurado antes de ejecutarse.
El perfil conservador no concede permisos automáticos para editar archivos o ejecutar comandos.
Un proceso con salida cero mantiene `verification:not_run`; la validación de tests, revisión y
despliegue necesita evidencia independiente. Esta supervisión no es un sandbox del sistema operativo.

`HERALD_PERSONAL_PROJECT_RUNS=1` proyecta revisiones al panel Desarrollo sin publicar prompts,
stdout, rutas privadas o credenciales. No completa automáticamente el compromiso humano.

## Rutinas y despliegue

Las cuatro propuestas de `routines/templates.json` están pausadas, sin destino: mañana, cierre,
seguimiento y supervisión. Deben registrarse mediante la interfaz pública de Hermes después de
configurar canal, destinatario y permisos. La entrega, respuesta, deduplicación y recuperación
requieren pruebas propias de cada instalación.

La instalación local depende de una Mac disponible. Para continuidad con ella apagada, utiliza
el [despliegue en VPS](../../deploy/personal/README.md) después de elegir un destino.
La configuración Kanban opcional usa su CLI pública en un home y tablero aislados, y crea tarjetas
bloqueadas sin asignar ni despachar agentes.
