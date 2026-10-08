# Verificación del servicio personal

La implementación se desarrolló mediante regresiones observadas antes de sus correcciones.
La distribución pública conserva las pruebas reproducibles; el historial de instalación y las
conexiones de operadores particulares no se publica.

82 pruebas verifican autenticación, límites, SQLite, idempotencia, revisiones, fechas, proveedores,
cursores, escrituras inciertas, paginación y proyecciones de agentes. La cobertura del servicio es
87.64%. Ruff y mypy pasan. Los proveedores usan transportes HTTP simulados.

La regresión de bandejas grandes recorre 60 mensajes sintéticos de 50,000 caracteres, con Unicode
y escapes, preserva sus cuerpos y evita duplicados. Cada respuesta queda dentro de 1 MiB y los
conteos del resumen abarcan toda la base.

```bash
cd services/personal
.venv/bin/python -m pytest --cov=herald_personal --cov-report=term-missing
.venv/bin/python -m ruff check herald_personal tests
.venv/bin/python -m mypy herald_personal
```

El instalador se verifica con 20 pruebas y 83% de cobertura; el launcher con 8. Sus fixtures
comprueban propiedad, conservación de SQLite, permisos, rechazo de redirecciones y plazo de inicio.
Estas pruebas no acreditan autorización ni disponibilidad de una cuenta externa.
