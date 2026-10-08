# Herald Personal de José

Fork de [Herald OS](https://github.com/iamlukethedev/Herald-OS) para correo, compromisos, seguimiento diario y supervisión de agentes. Conserva la licencia MIT y el reconocimiento del proyecto original. La interfaz nueva está en español.

| Herramienta | Responsabilidad |
| --- | --- |
| Hermes | Asistente personal: preparar resúmenes, capturar compromisos, consultar el diario y coordinar trabajos autorizados. |
| Claude Code | Desarrollo y revisión de una tarea con alcance definido. |
| OpenCode | Desarrollo con el proveedor/modelo elegido y el mismo control de alcance. |
| Herald Personal | Interfaz y registro compartido de esas actividades. |

Un modelo como DeepSeek puede usarse dentro de un ejecutor compatible. No hace falta añadir otro coordinador para utilizarlo.

## Inicio local

Requisitos: Node 22.12+, Python 3.13, uv y una instalación de Hermes compatible.

```bash
npm ci --ignore-scripts
node node_modules/electron/install.js
npm run sync-upstream
bash scripts/setup-personal.sh
npm run build
npm run personal:desktop
```

`personal:init` crea un token privado y almacenamiento sin datos de demostración. `personal:desktop` conecta con el servicio o lo inicia mientras la aplicación está abierta. Para que persista al cerrar Herald, consultar [instalación local](docs/personal/LOCAL-SERVICE.md). El entorno propio de este fork está separado del perfil predeterminado de Hermes.

En macOS, después de preparar el entorno, instala el servicio con `python3 scripts/install-personal-macos.py install`. El launcher del checkout y la aplicación empaquetada se conectan a esa misma instancia privada. `npm run personal:doctor` comprueba la conexión sin mostrar credenciales. Los datos se conservan al actualizar o retirar el inicio automático.

## Funciones

- **Hoy:** prioridades, vencimientos, estado de correo y resumen basado en registros.
- **Correo:** sincronización incremental Microsoft 365/Gmail, búsqueda, clasificación y conversión idempotente en compromiso. El contenido se muestra como texto.
- **Compromisos:** estado, prioridad, proyecto, fecha, revisiones y auditoría; una edición antigua no sobrescribe otra nueva.
- **Diario:** una entrada por fecha de Tegucigalpa, con avances, pendientes y siguiente paso.
- **Desarrollo:** ejecuciones e intentos con estado, código de salida y hashes de evidencia. Terminar un proceso no marca el trabajo como verificado.

## Configuración y alcance

Las credenciales permanecen en el servicio y el proceso principal de Electron. Microsoft 365 admite renovación silenciosa MSAL con caché privada; Gmail acepta un archivo de token mantenido por el cliente OAuth del operador. El repositorio no contiene cuentas conectadas ni credenciales.

La sincronización procesa un lote acotado por llamada y conserva un cursor para continuar. Los resúmenes reflejan los mensajes sincronizados. La vista de correo pagina los resultados y limita el tamaño de cada respuesta; conserva íntegro el texto almacenado de cada mensaje. El archivo y los borradores están desactivados de forma predeterminada. No existen funciones de envío o borrado de correo.

Las skills y perfiles concretos se describen en [Hermes](docs/personal/HERMES.md); los límites de la API en [servicio personal](services/personal/README.md). Las rutinas de WhatsApp se entregan pausadas y requieren canal y destino verificados. Para continuidad cuando la Mac está apagada, consultar [despliegue en VPS](deploy/personal/README.md).

## Verificación

Los resultados de entrega y sus límites están en [VALIDACIÓN](docs/personal/VALIDACION.md). Para repetir las comprobaciones de código:

```bash
npm run typecheck
npm test
npm run build
cd services/personal
.venv/bin/python -m pytest --cov=herald_personal
.venv/bin/python -m ruff check herald_personal tests
.venv/bin/python -m mypy herald_personal
```

Las pruebas de proveedores utilizan HTTP simulado. Las pruebas de conexión real se identifican por separado; ningún test unitario demuestra entrega de WhatsApp ni despliegue en una nube.
