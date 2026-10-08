# Verificación MCP y supervisión

34 pruebas cubren identidad compartida con el API, límites de lectura y paginación, revisión,
autorización de escrituras, catálogo por rol, errores redactados, supervisor durable, cancelación,
presupuesto, concurrencia, reintentos explícitos y Kanban aislado.

Un cliente real del SDK MCP inicia un servidor stdio y consulta un API fixture. Los trabajadores
de supervisión son procesos temporales de prueba; no realizan trabajos en cuentas ni repositorios
de un operador. La instantánea del panel conserva verificación pendiente.

```bash
PYTHONPATH=integrations/hermes-personal/src \
services/personal/.venv/bin/python -m unittest discover -s integrations/hermes-personal/tests -v

services/personal/.venv/bin/python -m ruff check \
  integrations/hermes-personal/src integrations/hermes-personal/tests
```

La suite requiere bind loopback para su servidor fixture. No necesita autorización de un proveedor
cloud ni cuentas de Claude/OpenCode. Cada instalación debe comprobar por separado el modelo,
las autorizaciones del proveedor, el alcance del agente y su resultado. La evidencia de una
instalación privada se conserva fuera del historial público.
