# Inicio sin invitación de proveedor

Herald consulta el estado de conexión al iniciar, sin abrir una invitación a iniciar sesión.
La recuperación aparece cuando una conversación falla por autenticación o cuando el usuario
pide iniciar sesión. El proveedor se obtiene exclusivamente de la configuración: no se usa
el primero de la lista OAuth como sustituto de un proveedor desconocido, automático o ausente.

Si no se puede identificar el proveedor OAuth, el aviso ofrece **Elegir proveedor en Ajustes**.
Ese botón cierra el aviso y abre la sección del modelo. Los mensajes de configuración de este
aviso no incluyen rutas internas del runtime ni promocionan un proveedor alternativo.
Las credenciales, la selección del modelo y las políticas de herramientas no se modifican.

## Evidencia TDD

- RED `79be865`: 8 fallos de 14 pruebas reprodujeron la apertura automática, la selección
  incorrecta de Nous, la conservación de un proveedor eliminado y el aviso engañoso.
- GREEN `6200d89`: las mismas 14 pruebas pasaron con inicio silencioso, selección explícita,
  recuperación manual y cierre del aviso después de autenticar el proveedor activo.
- Las pruebas del store usan respuestas de proveedor simuladas; las de la tarjeta renderizan
  el componente real. No requieren credenciales, no abren portales y no llaman a modelos.

Comando focalizado:

```sh
npm test --workspace apps/desktop -- src/store/hermes-auth.test.ts src/features/auth/HermesLoginCard.test.ts
```
