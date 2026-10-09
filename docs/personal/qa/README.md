# Verificación de la interfaz personal

Esta carpeta contiene evidencia **exclusivamente sintética** de la aplicación Electron completa. La ejecución final del **9 de octubre de 2026, 02:17:24–02:18:22 UTC** aprobó **13 comprobaciones** y produjo diez capturas. El [reporte](report.json) contiene cero excepciones JavaScript, cero errores de consola durante el recorrido y dos avisos WebSocket marcados expresamente en la fase de cierre.

## Reproducción

Desde la raíz del repositorio, con dependencias JavaScript y el entorno `services/personal/.venv`:

```sh
npm run build
node scripts/qa-personal-electron.mjs
```

Requiere una sesión gráfica de macOS y permiso de bind loopback para los servicios de prueba. Playwright se resuelve desde `apps/desktop`; `PLAYWRIGHT_MODULE` admite otra instalación. `HERALD_OS_HERMES_ROOT` puede indicar la instalación Hermes, por defecto `~/.hermes/hermes-agent`.

El recorrido utiliza main, preload, IPC, API HTTP real, SQLite y MCP del SDK oficial. No sustituye `window.heraldOS.personal` ni utiliza las cuentas del operador. API, workspace de correo, tokens, base y perfiles de QA están aislados de la instalación personal. El script cierra los procesos y homes temporales que creó; la base sintética se conserva en `.runtime/qa/` hasta la próxima prueba.

## Recorridos

1. El argumento de apertura programada enfoca Personal después del arranque del renderer y muestra conexión autenticada.
2. El plan se genera una vez por acción explícita, conserva sus fuentes y no se regenera al cambiar de pestaña.
3. Crear y editar un compromiso conserva identidad, revisiones y vencimiento de Tegucigalpa.
4. Una revisión antigua se rechaza; se conserva el borrador y se recupera la versión guardada.
5. El diario conserva el borrador al cambiar de pestaña y su guardado no altera compromisos.
6. El workspace de correo se renderiza en un guest visible y con dimensiones útiles. No recibe `window.heraldOS` y conserva el borrador al ocultarlo y mostrarlo.
7. La selección nativa del correo y la captura por MCP usan la misma clave `MAIL-n` y producen un único compromiso.
8. La navegación integrada abre la vista Seguimiento de la aplicación original de fixture.
9. Desarrollo separa observaciones de sesiones y runs; un resultado de proceso continúa sin verificación.
10. La desconexión conserva la última instantánea y se recupera tras reiniciar el API.
11. Reiniciar app y servicio conserva tareas, diario, vínculo de correo y datos de desarrollo.
12. Las solicitudes al proveedor sintético son únicamente GET; se rechazan errores activos del renderer.

El reporte enumera las trece aserciones agrupadas de estos recorridos. La fixture de Microsoft 365 mantiene 55 mensajes para las pruebas heredadas, y el workspace actual dispone de su propio servidor sintético con claves MAIL-n. No se contacta Microsoft ni se prueban envíos reales.

**`05c-qa-vista-nativa.png`** captura directamente el WebContentsView de correo. Una captura del renderer padre no incluye esa superficie; no se usa el rectángulo vacío de la captura del shell para juzgar si el correo está visible. Las capturas antiguas de paginación de la primera entrega ya no describen el flujo activo y se retiraron.

## Errores y datos

Cada error del reporte conserva hora y fase. Los avisos de cierre no se reclasifican retrospectivamente: el script marca teardown antes de cerrar su instancia. La redacción elimina tokens de URL, bearer y campos API key. Puede comprobarse sin abrir servicios:

```sh
node scripts/qa-personal-electron.mjs --check-log-redaction
```

Los mensajes y capturas se identifican como datos sintéticos. Las observaciones de desarrollo son fixtures; no acreditan un trabajo real ejecutado, probado o revisado. La evidencia de la app instalada y la cuenta real pertenece al registro privado de cada operador.

## Código

| Comprobación | Resultado |
| --- | --- |
| Suite completa del escritorio | 886 tests en 109 archivos, PASS |
| Unidades personales dirigidas | 110 tests, PASS |
| Cobertura dirigida de UI personal | 96.6% sentencias y 83.75% ramas |
| TypeScript del renderer y Electron | PASS |
| Build de renderer, main y preload | PASS |

Las regresiones cubren rutas y filtros permitidos, bloqueo durante redacción, límites de navegación, subframes, eventos tempranos, conservación del guest y apertura después del arranque. La cobertura dirigida no representa toda la aplicación ni una auditoría de accesibilidad con lector de pantalla. El build conserva avisos anteriores de tamaño de bundles e imports mixtos.
