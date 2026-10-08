# Verificación de la interfaz personal

Esta carpeta contiene evidencia **exclusivamente sintética** de la aplicación Electron completa. El resultado de cada ejecución está en [report.json](report.json), junto a sus capturas PNG. Los mensajes usan `example.test` y el espacio visible se identifica como «QA · DATOS SINTÉTICOS».

La ejecución final del **8 de octubre de 2026, 22:30:12–22:31:12 UTC**, aprobó sus **12 comprobaciones** con **55 mensajes** y produjo 11 capturas. El reporte final tiene cero excepciones JavaScript, cero errores de consola activos y cero mensajes de error durante el cierre. Un aviso WebSocket de la ejecución anterior se conservó redactado en el directorio privado de QA; esa captura anterior no tenía una marca de fase y no se utiliza para afirmar cuándo ocurrió.

## Reproducción

Desde la raíz del repositorio, con las dependencias JavaScript y el entorno Python de `services/personal/.venv` instalados:

```sh
npm run build
node scripts/qa-personal-electron.mjs
```

Se necesita una sesión gráfica de macOS y permiso para escuchar en `127.0.0.1:8788` y abrir Electron. Playwright se resuelve desde las dependencias del workspace `apps/desktop`. `PLAYWRIGHT_MODULE` permite indicar otra instalación compatible. `HERALD_OS_HERMES_ROOT` permite indicar la instalación de Hermes; por defecto se utiliza `~/.hermes/hermes-agent`.

El recorrido ejecuta el `main` compilado, su preload y la API HTTP real sobre SQLite. No sustituye `window.heraldOS.personal`, no omite el arranque normal del backend de Herald y no utiliza los registros ni las credenciales de la cuenta del operador.

## Aislamiento

- El servicio de pruebas escucha únicamente en el puerto 8788. El servicio personal instalado utiliza otra ubicación y otro puerto.
- La base de datos, el perfil Chromium, los registros de prueba y el token de acceso quedan bajo `.runtime/qa/`, excluido de Git. Cada ejecución reinicia únicamente la base sintética de ese directorio.
- El token de QA se genera con permisos `0600`; nunca se entrega al renderer ni se incluye en el reporte.
- Hermes utiliza un home temporal privado bajo `/private/tmp/herald-personal-qa-*`. La ruta corta respeta el límite de sockets Unix de macOS. El script elimina solamente el home temporal que creó.
- Microsoft 365 se conecta a un `httpx.MockTransport` con 55 mensajes sintéticos; ninguna solicitud llega a Microsoft. Gmail permanece sin configurar. Borradores y archivo están deshabilitados en el servicio de QA.
- La captura por MCP usa el SDK oficial, transporte stdio y el servidor `herald_hermes` real contra el mismo servicio sintético.
- Al terminar, el script cierra su Electron y su servicio. La base sintética se conserva para inspección hasta la próxima ejecución.

## Qué comprueba

El reporte enumera cada comprobación aprobada y registra cada error con hora y fase. `consoleErrors` contiene mensajes del arranque y recorrido activo; `teardownConsoleErrors` conserva los mensajes recibidos después de marcar explícitamente el cierre de la instancia correspondiente. Un error activo o una excepción JavaScript hacen fallar el resultado. Los avisos durante el cierre quedan visibles y no se atribuyen retrospectivamente a esa fase. Tokens de URL, valores bearer y campos token/API key se redactan antes de incorporarlos al reporte.

La redacción puede verificarse sin iniciar servicios ni Electron:

```sh
node scripts/qa-personal-electron.mjs --check-log-redaction
```

El recorrido cubre:

1. Conexión personal autenticada desde Electron y perfil aislado.
2. Crear, editar y cambiar estado de un compromiso desde los controles de la interfaz; comprobar el registro persistido después de cada operación.
3. Preservar el vencimiento de una fecha local hasta el final del día de Tegucigalpa.
4. Rechazar una escritura con revisión antigua, conservar el borrador local y recuperar la versión guardada antes de continuar.
5. Guardar el diario, conservar lo escrito al cambiar de pestaña y comprobar que la entrada no altera el estado del compromiso.
6. Sincronizar 55 correos sintéticos, recorrer sus páginas conservando la selección, buscar y clasificar un mensaje, mostrar su contenido como texto y mantener deshabilitadas las escrituras del proveedor.
7. Capturar el mismo mensaje desde la interfaz y desde MCP, verificando un único ID de compromiso y un solo vínculo de origen.
8. Mostrar una instantánea persistida de desarrollo con salida de proceso y validación pendiente como estados separados.
9. Preparar el cierre con datos guardados, mostrar desconexión conservando la última consulta y recuperar la conexión.
10. Reiniciar Electron y el servicio; comprobar que tareas, diario, vínculo del correo e instantánea de desarrollo conservan identidad y contenido.

## Límites de esta evidencia

La prueba comprueba la UI y su integración local completa. El proveedor externo utiliza un transporte sintético: este reporte no certifica OAuth, permisos ni escrituras en una cuenta real. La instantánea de desarrollo se inserta deliberadamente como fixture persistida; no representa la ejecución ni la verificación de un trabajo real de Claude Code u OpenCode. La confirmación de borrador, archivo y restauración se cubre con pruebas de comandos y controlador; esta ejecución gráfica comprueba que dichos controles permanecen bloqueados cuando el servicio no concede sus capacidades.

Las capturas registran la interfaz con los colores y componentes existentes de Herald OS. Se inspeccionan como evidencia de lectura, navegación, estados y controles; no sustituyen una auditoría de accesibilidad con lector de pantalla.

## Verificación de código

Después de corregir los nombres accesibles de los campos y la presentación de errores e historial, las comprobaciones locales del 8 de octubre de 2026 dieron:

| Comprobación | Resultado |
| --- | --- |
| Modelo, controlador y comandos personales | 61 pruebas aprobadas |
| Las anteriores más el registro general de comandos | 87 pruebas aprobadas |
| `tsc -p tsconfig.json --noEmit` en `apps/desktop` | Aprobado |
| `npm run build` | Renderer, main y preload compilados |
| `git diff --check` | Aprobado |
| Cobertura dirigida a `model.ts`, `controller.ts` y `commands/personal.ts` | 99.34% sentencias; 86.95% ramas; 100% funciones y líneas |

Esta cifra de cobertura corresponde a las tres unidades indicadas, no a todos los componentes React ni a toda la aplicación. El build conserva avisos preexistentes de tamaño de bundles e imports estáticos/dinámicos mixtos; no produjo errores de compilación.

El primer recorrido gráfico detectó que las etiquetas implícitas de algunos campos incluían opciones o ayudas. La corrección utiliza nombres y descripciones accesibles explícitos. La inspección de sus capturas detectó también el prefijo IPC visible y el JSON del historial; las pruebas de regresión fallaron antes de implementar mensajes legibles y resúmenes de cambios.
