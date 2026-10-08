# Servicio personal local en macOS

El servicio se instala por usuario en `~/Library/Application Support/Herald Personal`. Su Python,
módulos, datos, perfiles, credenciales, PID y logs quedan fuera de `Documents`. Esto evita depender
de que un proceso iniciado por `launchd` pueda leer el checkout protegido por macOS.

El instalador no configura cloud, WhatsApp, canales de mensajes ni rutinas. La Mac y la sesión del
usuario deben estar disponibles. Las escrituras de correo siguen desactivadas. No se copian
configuraciones de prueba con autoridad para lanzar agentes.

## Instalación

Prerrequisitos: macOS, `uv` disponible, dependencias fijadas en
`services/personal/requirements.lock`, y el entorno aislado `.runtime` preparado. El token del API
y los archivos de credenciales deben ser propios, regulares y privados (`0600`). El puerto 8787
debe estar libre o corresponder al LaunchAgent propio que se está migrando.

Desde la raíz del fork:

```sh
python3 scripts/install-personal-macos.py install --dry-run
python3 scripts/install-personal-macos.py install
```

`--dry-run` valida fuentes, propiedad, rutas y configuración sin crear archivos, ejecutar `uv`,
iniciar procesos ni consultar proveedores. La ejecución real:

1. Rechaza un destino existente sin el marcador propio o un LaunchAgent que pertenezca a otro
   repositorio/programa. La migración del antiguo servicio solo acepta su directorio de trabajo
   exacto `services/personal` dentro de este checkout.
2. Detiene únicamente `gui/<uid>/dev.josetabora.herald-personal` cuando su registro coincide con el
   plist propio. No usa `kill`, `killall` ni `pkill` y no libera un puerto ocupado por otro programa.
3. Copia los módulos de servicio y MCP a `lib`, crea `.venv` con Python 3.13 e instala exclusivamente
   el lock con `uv pip install --require-hashes`. Comprueba que servicio, MCP, MSAL y Uvicorn importan.
4. Copia el token y los archivos permitidos de correo desde `.runtime/private` cuando faltan en el
   destino. Las rutas de las copias privadas se escriben en la configuración instalada. Una copia
   existente del token o MSAL se conserva, incluidas sus renovaciones posteriores.
5. Migra SQLite con la API de respaldo, incluyendo los cambios confirmados presentes en WAL. En
   una reinstalación conserva la base de destino y crea un respaldo privado antes de actualizar.
6. Copia los perfiles personales aislados, SOUL, skills y `auth.json` privado cuando existe. Conserva
   la selección del modelo y reescribe únicamente el servidor MCP propio para usar Python, módulos
   y token instalados. No copia `.env` ni archivos de canales. Los perfiles existentes y su acceso
   al modelo se conservan. El archivo `private/operator.json` inicial tiene scopes, workspaces y
   agentes vacíos: el operador debe aprobar y registrar cada alcance real por separado.
7. Registra el LaunchAgent con rutas instaladas, lo inicia y verifica `/v1/status` con autenticación.
   Solo tras esa confirmación publica los archivos de conexión. La comprobación rechaza redirecciones.

Puede repetirse el mismo comando desde este repositorio. No se reemplazan datos ni credenciales
instalados con copias viejas de `.runtime`. Se actualizan módulos y dependencias fijadas; un fallo
intermedio se informa como fallo, no como servicio listo. Los datos permanecen para poder revisar
y repetir la instalación. El instalador no elimina automáticamente paquetes o archivos personales.

## Archivos de conexión y operación

| Ubicación dentro del destino | Uso |
| --- | --- |
| `.herald-personal-install.json` | Identidad de la instalación y repositorio propietario |
| `connection.json` | `{ "url": "http://127.0.0.1:8787", "tokenFile": "/ruta/privada/api-token" }`, modo 600 |
| `private/api-token` | Token del API, nunca incrustado en el plist o renderer |
| `private/mail-settings.json` | Rutas y metadatos permitidos del proveedor; escritura de correo desactivada |
| `private/microsoft365-msal.json` | Copia aislada del cache delegado cuando está configurado |
| `data/personal.sqlite3` | Compromisos, diario, correo y proyecciones de ejecuciones |
| `backups/*.sqlite3` | Respaldos íntegros anteriores a una reinstalación |
| `hermes-home` / `coder-home` | Perfiles aislados; no sustituyen `~/.hermes` |
| `run/service.pid` | PID observado del servicio; nunca se usa como autoridad para detener procesos |
| `logs/service.stdout.log` / `logs/service.stderr.log` | Logs privados del proceso |

El plist está en `~/Library/LaunchAgents/dev.josetabora.herald-personal.plist`. Los permisos existentes
del directorio `LaunchAgents` se conservan. El servicio se liga únicamente a `127.0.0.1:8787`.

El manifiesto `.runtime/private/installed-runtime.json` del checkout contiene exclusivamente
`dataDir`, `tokenFile`, `hermesHome`, `pythonPath` y `connectionFile`, sin valores secretos. Electron
y el launcher del checkout pueden resolver desde ese manifiesto la misma instancia instalada.

Para consultar el registro de macOS:

```sh
launchctl print "gui/$(id -u)/dev.josetabora.herald-personal"
```

Una salida de `launchctl` registrada no prueba que la API haya iniciado: la instalación solo declara
éxito cuando obtiene una respuesta autenticada. El arranque en frío tiene un plazo monotónico de
60 segundos, con sondeos de hasta un segundo y pausas de hasta 250 ms. Tampoco prueba una
sincronización de correo, una llamada de modelo, una entrega WhatsApp ni el funcionamiento con
la Mac apagada.

## Retirar el inicio automático conservando los datos

```sh
python3 scripts/install-personal-macos.py uninstall
```

El comando valida la propiedad, retira únicamente este servicio y elimina su plist. Conserva base,
respaldos, token, acceso al modelo, perfiles y archivos de conexión. No detiene Hermes global ni
ningún otro agente. Volver a instalar reutiliza esos archivos.

## Evidencia

Las pruebas del instalador están en `scripts/test_install_personal_macos.py`. Utilizan directorios
temporales, una base SQLite real y un límite de procesos simulado; nunca ejecutan `uv`, `launchctl`
ni llamadas a una cuenta real. La prueba de redirecciones usa el motor real de redirecciones de
`urllib` con transporte HTTP simulado, sin abrir sockets.

El checkpoint RED inicial es `525e13c`; el primer GREEN es `b50ae46` con 15 casos aprobados. El RED
de seguridad es `a6f3ce2` y su GREEN es `c60b73e`. El RED de arranque en frío `5a486b6` reprodujo una
API lista a los 12 segundos que la espera anterior daba por fallida a los diez. La verificación
final aprueba 20 casos con cobertura del 83%, incluidas ramas. Las regresiones adicionales cubren
rutas privadas con ancestros simbólicos, preservación
de permisos del directorio global y no divulgación de bearer al recibir redirecciones. La ejecución
real del instalador y el estado final de `launchd` requieren evidencia independiente del agente
principal.
