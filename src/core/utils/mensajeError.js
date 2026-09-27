// Sequelize agrupa los errores de validación/base de datos bajo un
// mensaje genérico ("Validation error", "Database error"...) y deja el
// detalle real adentro (error.errors[] o error.original). Este helper
// lo desenreda para que el usuario vea algo accionable, no un genérico.
function mensajeError(error) {
  if (error.name === 'SequelizeValidationError' && Array.isArray(error.errors) && error.errors.length > 0) {
    return error.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
  }
  if (error.name === 'SequelizeUniqueConstraintError' && Array.isArray(error.errors) && error.errors.length > 0) {
    return error.errors.map((e) => `${e.path}: ya existe un registro con ese valor`).join('; ');
  }
  if (error.original && error.original.message) {
    return error.original.message;
  }
  return error.message;
}

module.exports = { mensajeError };
