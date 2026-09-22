# Módulo: inventarios

Pendiente de construir. Sigue exactamente el mismo patrón que `src/modules/ventas`:

- `models/`   → entidades Sequelize del módulo
- `services/` → lógica de negocio, siempre contabiliza a través de
                 `src/core/services/motorAsientos.js`, nunca escribiendo
                 asientos directamente
- `controllers/` → capa HTTP
- `routes/`   → se montan en `src/routes/index.js`

Consulta la tabla de reglas de contabilización de este módulo definida
en la conversación de diseño para los eventos (`tipoEvento`) y niveles
de automatización correspondientes.
