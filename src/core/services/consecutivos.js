const { Op } = require('sequelize');
const sequelize = require('../../config/database');

// Genera un consecutivo legible tipo "COT-2026-0001", contando cuántos
// documentos de ese prefijo existen ya este año para la empresa.
async function generarConsecutivo(empresaId, prefijo, Modelo) {
  const anio = new Date().getFullYear();
  const conteo = await Modelo.count({
    where: {
      empresaId,
      consecutivo: { [Op.like]: `${prefijo}-${anio}-%` },
    },
  });
  const numero = String(conteo + 1).padStart(4, '0');
  return `${prefijo}-${anio}-${numero}`;
}

// Genera el consecutivo y ejecuta TODA la creación (encabezado + ítems +
// lo que haga falta) dentro de una transacción real: o se guarda todo,
// o no se guarda nada — así nunca queda un encabezado "huérfano" con un
// consecutivo gastado si algo falla más adelante en el mismo proceso
// (por ejemplo, al crear un ítem). Además reintenta automáticamente si
// dos creaciones casi simultáneas chocan en el mismo número.
//
// `crear(consecutivo, transaction)` debe hacer TODO el trabajo —
// Cotizacion.create(..., { transaction }), CotizacionItem.create(...,
// { transaction }), etc. — pasando siempre esa misma transacción.
async function crearConSecutivoUnico(Modelo, empresaId, prefijo, crear) {
  const MAX_INTENTOS = 5;

  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    const consecutivo = await generarConsecutivo(empresaId, prefijo, Modelo);

    try {
      return await sequelize.transaction((transaction) => crear(consecutivo, transaction));
    } catch (error) {
      const chocoPorConsecutivo =
        error.name === 'SequelizeUniqueConstraintError' &&
        Array.isArray(error.errors) &&
        error.errors.some((e) => e.path === 'consecutivo');

      if (!chocoPorConsecutivo || intento === MAX_INTENTOS) {
        throw error;
      }
      // La transacción completa ya hizo rollback sola — no queda nada
      // huérfano. Se reintenta con el siguiente número, sin que el
      // usuario tenga que hacer nada.
    }
  }
}

module.exports = { generarConsecutivo, crearConSecutivoUnico };
