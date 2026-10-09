# Conversaciones en Herald Personal

Desde la versión **0.1.0-personal.3**, entra en **Hermes** y encontrarás el **Historial** abierto a la izquierda.

- Pulsa una conversación para recuperar sus mensajes y continuar en esa misma sesión.
- Busca por título, palabras del contenido o ID y pulsa Enter o la lupa. La búsqueda consulta el historial completo del perfil, incluidas las archivadas. Si hay más de 100 coincidencias, precisa el texto.
- **Cargar anteriores** recorre las siguientes páginas; la lista ya no se limita a las últimas 60 conversaciones. **Incluir archivadas** permite verlas sin buscarlas.
- **Actualizar historial** vuelve a consultar Hermes. Si falla, muestra el error y conserva la lista anterior.
- **Nueva conversación** abre un chat vacío. Hermes lo guarda cuando tiene su primer mensaje; los chats vacíos se identifican como no guardados.
- En **Acciones de conversación → Renombrar**, escribe un título y pulsa **Guardar título**. Se guarda en Hermes y permanece al reiniciar la aplicación.
- **Resultados** abre o cierra el panel de archivos, dejando más espacio para conversar.

Los borradores permanecen asociados a cada conversación mientras la app está abierta. Cambiar de chat no los mezcla; un error al enviar conserva el texto. Los borradores no enviados están en memoria y todavía no se recuperan después de cerrar la app. Los mensajes confirmados y los títulos sí se recuperan del historial de Hermes.

La eliminación requiere abrir la conversación y confirmar en su menú. No se elimina nada por pulsar una fila. Una respuesta activa debe detenerse antes de eliminarla.

## Perfiles

La lista indica **Perfil de Herald**. Solo consulta el home de Hermes conectado a esta app. Una instalación original de Hermes con otro `HERMES_HOME` tiene su propia base de conversaciones; actualizar el chat no importa ni mezcla esas bases. Los chats auxiliares de herramientas, tareas programadas y kanban no se incluyen en este historial.

## Validación reproducible

Las pruebas unitarias cubren paginación, búsqueda, fallos, reanudación, selección simultánea, renombrado persistente, envío a la sesión correcta y conservación de borradores. La prueba `node scripts/qa-chat-electron.mjs` usa la app Electron compilada y un home temporal de Hermes con 73 conversaciones sintéticas. Comprueba búsqueda por contenido, recuperación del historial, cambio entre borradores, renombrado y reapertura después de reiniciar la app y el backend. No envía prompts a proveedores de modelos.

La prueba de escritorio requiere macOS, las dependencias del proyecto y un runtime Hermes disponible en `HERALD_OS_HERMES_ROOT` o `~/.hermes/hermes-agent`. Sus datos y capturas quedan fuera de Git, en `.runtime/qa-chat`.
