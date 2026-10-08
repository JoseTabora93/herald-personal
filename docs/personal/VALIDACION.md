# Validación del software

Esta distribución contiene código, instrucciones generales y evidencia generada con datos
sintéticos. La configuración, cuentas, resultados de buzones, respaldos y registros operativos
de instalaciones particulares quedan fuera del repositorio y de su historial publicado.

| Comprobación | Resultado de la versión personal |
| --- | --- |
| Escritorio y transporte | 808 pruebas en 102 archivos, PASS |
| API personal | 82 pruebas, cobertura 87.64%, PASS |
| MCP y supervisor | 34 pruebas, PASS |
| Instalador macOS | 20 pruebas, cobertura 83%, PASS |
| Launcher local | 8 pruebas, PASS |
| Plugin upstream | 303 pruebas, PASS |
| Electron integrado | 12 recorridos con datos sintéticos, PASS |
| TypeScript y build | PASS |

El recorrido Electron usa renderer, preload, IPC, API HTTP, SQLite y un cliente MCP oficial.
Comprueba conflictos de revisión, fechas, correo paginado, captura idempotente, diario,
desconexión, recuperación y persistencia después de reiniciar. El reporte y las capturas están en
[qa](qa/README.md). Las instantáneas de agentes son fixtures; no acreditan trabajo de un agente real.

Las pruebas de proveedores utilizan HTTP simulado. Cada instalación debe validar por separado
sus autorizaciones, sincronización real, entrega de mensajes y continuidad. Un build aprobado
no demuestra que una cuenta esté conectada o que exista un servidor disponible permanentemente.

Los comandos de verificación figuran en [la guía](../../README-PERSONAL.md),
[el servicio](../../services/personal/TDD-EVIDENCE.md) y
[la integración Hermes](../../integrations/hermes-personal/VERIFICATION.md).
Consulta el resultado del commit publicado en GitHub Actions para conocer el estado de CI remoto.

Gitleaks comprueba el historial y cambios antes de publicar. La única exclusión específica
corresponde al atajo upstream literal `mod+shift+enter`. La auditoría de dependencias de
producción no encontró vulnerabilidades; existen avisos moderados en herramientas de empaquetado.
