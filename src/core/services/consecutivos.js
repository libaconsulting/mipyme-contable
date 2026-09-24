const { Op } = require('sequelize');

// Genera un consecutivo legible tipo "COT-2026-0001", contando cuántos
// documentos de ese prefijo existen ya este año para la empresa.
//
// LIMITACIÓN CONOCIDA: no usa bloqueo transaccional, así que dos
// creaciones en el mismo instante podrían, en teoría, generar el mismo
// número. Para el volumen actual no es un riesgo real; si el volumen de
// documentos crece, esto debería moverse a una tabla de secuencias con
// bloqueo (SELECT ... FOR UPDATE) en vez de un conteo simple.
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

module.exports = { generarConsecutivo };
