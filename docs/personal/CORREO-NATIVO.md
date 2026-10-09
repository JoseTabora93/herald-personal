# Correo nativo en Herald Personal

La interfaz habitual de **Personal → Correo** es React dentro de Herald desde la versión
`0.1.0-personal.4`. El servicio de correo existente conserva los mensajes, estados, JEV,
redactor, revisor, aprendizajes y acceso a Microsoft 365. No se importa el buzón a otra base.

## Uso

- **Tablero, Lista y Seguimiento:** búsqueda, carpetas, período, estado, categoría, prioridad,
  no leídos y dudas de JEV. Las páginas consultan 25 hilos de la fuente existente.
- **Lectura:** el panel derecho muestra mensajes como texto seguro, destinatarios y nombres
  de adjuntos. Abrir un hilo no marca correos como leídos ni cambia automáticamente su estado.
  El lector carga diez mensajes recientes y permite ampliar a 25; el hilo completo y la descarga
  de adjuntos siguen accesibles en la vista original.
- **Clasificación:** los selectores guardan estado, categoría y prioridad en la base del servicio;
  se relee el resultado antes de confirmar. Se respetan sus bloqueos manuales y aprendizaje.
- **Compromiso y Hermes:** trabajan con la clave `MAIL-n` seleccionada. El compromiso reutiliza
  la identidad canónica y Hermes recibe la referencia al hilo.
- **Redactor:** responder, responder a todos, reenviar o crear. Para/CC/CCO, asunto, texto Markdown,
  vista previa y firma. **Guardar borrador** guarda y verifica el resultado. El indicador distingue
  cambios pendientes; el texto se conserva ante un error. La reapertura de la app recupera el último
  borrador abierto y guardado. El navegador conserva solo su identificador, nunca su cuerpo.
- **Redactor y revisor existentes:** generan o ajustan un borrador a petición del usuario, muestran
  notas, datos pendientes, fuentes y versiones. Estas funciones usan la configuración del servicio
  actual y pueden llamar a sus modelos. No hay generación automática al abrir un hilo.
- **Aprendizajes y Limpieza:** muestran las propuestas reales y sus evidencias en componentes
  de Herald. Rezagados e Histórico consultan las colas originales y el progreso de carga.

## Confirmaciones que conservan su interfaz original

**Adjuntos, Outlook y envío** abre el mismo borrador guardado en la interfaz original.
Allí se adjuntan archivos, se crea el borrador de Outlook o se revisa el envío y su ventana
de deshacer. Cierra ese editor para habilitar **Volver a Correo de Herald**.

Las decisiones de limpieza, reglas, lotes y activación de aprendizajes conservan también su
pantalla original. Esta transición evita duplicar o debilitar su autorización de sesión,
capacidad de interfaz y ticket de confirmación. La vista original es una opción de compatibilidad;
no se crea ningún `WebContentsView` para la bandeja o el lector habituales.

## Contratos y límites

- `/v1/mail-workspace/query`: lista explícita de acciones GET; las herramientas de Hermes
  conservan el puente de lectura.
- `/v1/mail-workspace/local`: contratos estrictos para clasificación y borradores locales.
  Incluye lectura de compose, abrir/guardar, generación/ajuste y versiones. No admite envío,
  Outlook, limpieza, aprobación, sincronización ni descarte que pudiera borrar un draft de Outlook.
- Credencial únicamente en Electron main/servicio; jamás se simulan cookies, origen de navegador
  o capacidades `uiOnly`. Sin reintentos automáticos de escrituras.
- Respuestas de hasta 1 MiB, consultas paginadas y borradores editables hasta 50 000 caracteres.
  Los borradores de mayor tamaño pueden continuarse en la interfaz original.
- Ningún envío, modificación de buzón ni llamada a modelos reales forma parte del QA.

## Verificación reproducible

Desde la raíz del repositorio, con las dependencias instaladas y el runtime de Hermes disponible:

```sh
npm run typecheck
npm run test
services/personal/.venv/bin/pytest services/personal/tests/test_native_mail.py services/personal/tests/test_mail_workspace.py -q
npm run build
node scripts/qa-native-mail-electron.mjs
```

El último comando usa puertos locales 8794 y 8104, un perfil aislado y datos `QA SINTÉTICO`.
No debe ejecutarse si esos puertos pertenecen a otro proceso. Sus archivos están en
`.runtime/qa-native-mail`, fuera de Git. El guion comprueba la bandeja nativa sin guest,
paginación, búsqueda, contenido no ejecutable, clasificación, fallo de guardado, persistencia
tras reinicio, continuidad del borrador, propuestas, compromiso y ausencia de envíos.
