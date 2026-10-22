const { z } = require('zod');
const { emailSchema } = require('./validate-register');

const loginSchema = z.strictObject({
  email: emailSchema,
  // No aplicar la política de alta a claves heredadas ni transformar la clave.
  // El límite de bytes impide que bcrypt acepte sufijos truncados.
  password: z.string().min(1).refine((value) => !value.includes('\u0000')
    && Buffer.byteLength(value, 'utf8') <= 72),
});

function validateLogin(req, res, next) {
  const result = loginSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ success: false,
      message: 'Datos inválidos: envía solo email válido (máximo 150) y password (1–72 bytes UTF-8, sin caracteres nulos).' });
  }
  req.body = result.data;
  next();
}

module.exports = validateLogin;
