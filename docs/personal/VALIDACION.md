# Validación del software

Esta distribución contiene código, instrucciones generales y evidencia generada con datos
sintéticos. La configuración, cuentas, resultados de buzones, respaldos y registros operativos
de instalaciones particulares quedan fuera del repositorio y de su historial publicado.

| Comprobación | Resultado de la versión personal |
| --- | --- |
| Escritorio y transporte | 886 pruebas en 109 archivos, PASS |
| API personal | 152 pruebas, cobertura 89.35%, PASS |
| MCP, supervisor, observador y jobs | 71 pruebas; 90% de cobertura de módulos modificados, PASS |
| Instalador macOS y wrappers cron | 21 + 2 pruebas, PASS |
| Launcher local | 8 pruebas, PASS |
| Plugin upstream | 303 pruebas, PASS |
| Electron integrado | 13 comprobaciones con datos sintéticos, PASS |
| TypeScript y build | PASS |

El recorrido Electron usa renderer, preload, IPC, API HTTP, SQLite y un cliente MCP oficial.
Comprueba conflictos de revisión, fechas, guest de correo aislado, conservación del borrador,
captura por la misma clave MAIL-n, apertura del plan, diario, desconexión y persistencia tras reiniciar. El reporte y las capturas están en
[qa](qa/README.md). Las instantáneas de agentes son fixtures; no acreditan trabajo de un agente real.

Las pruebas de proveedores utilizan HTTP simulado. Cada instalación debe validar por separado
sus autorizaciones, sincronización real, entrega de mensajes y continuidad. Un build aprobado
no demuestra que una cuenta esté conectada o que exista un servidor disponible permanentemente.

Las pruebas nuevas cubren autoridad exclusiva de correo, límites de respuesta, scopes del
observador, degradación por datos vencidos, autorización, revisiones y reclamaciones diarias.
El reporte gráfico registra cero errores activos y dos avisos WebSocket durante el cierre.
Las plantillas de jobs permanecen pausadas y el modelo desactivado para una nueva instalación.

Los comandos de verificación figuran en [la guía](../../README-PERSONAL.md),
[el servicio](../../services/personal/TDD-EVIDENCE.md) y
[la integración Hermes](../../integrations/hermes-personal/VERIFICATION.md).
Consulta el resultado del commit publicado en GitHub Actions para conocer el estado de CI remoto.

Gitleaks comprueba el historial y cambios antes de publicar. La única exclusión específica
corresponde al atajo upstream literal `mod+shift+enter`. La auditoría de dependencias de
producción no encontró vulnerabilidades; existen avisos moderados en herramientas de empaquetado.
