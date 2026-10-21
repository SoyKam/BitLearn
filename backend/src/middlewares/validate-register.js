const { z } = require('zod');

const registerSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
  email: z.string().trim().toLowerCase().max(150).pipe(z.email()),
  password: z.string().min(12).refine((value) => value.trim().length > 0
    && !value.includes('\u0000') && Buffer.byteLength(value, 'utf8') <= 72),
});

function validateRegister(req, res, next) {
  const result = registerSchema.safeParse(req.body);
  if (!result.success) {
    // No serializar errores de Zod: pueden incluir nombres de campos arbitrarios.
    return res.status(400).json({
      success: false,
      message: 'Datos inválidos: envía solo name (1–100 caracteres), email válido (máximo 150) y password (mínimo 12 caracteres, máximo 72 bytes UTF-8, no vacío ni con caracteres nulos).',
    });
  }
  req.body = result.data;
  next();
}

module.exports = validateRegister;
