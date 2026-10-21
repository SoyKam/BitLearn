const { Router, json } = require('express');
const createAuthController = require('../controllers/auth.controller');
const validateRegister = require('../middlewares/validate-register');
const createRegisterRateLimit = require('../middlewares/register-rate-limit');
const requestContext = require('../middlewares/request-context');

/**
 * @swagger
 * components:
 *   schemas:
 *     RegisterInput:
 *       type: object
 *       additionalProperties: false
 *       required: [name, email, password]
 *       properties:
 *         name:
 *           type: string
 *           minLength: 1
 *           maxLength: 100
 *           description: Se recortan los espacios exteriores; no admite caracteres de control.
 *         email:
 *           type: string
 *           format: email
 *           maxLength: 150
 *           description: Se recortan los espacios exteriores y se convierte a minúsculas antes de validar.
 *         password:
 *           type: string
 *           format: password
 *           writeOnly: true
 *           minLength: 12
 *           maxLength: 72
 *           description: Máximo 72 bytes UTF-8. No se recorta ni normaliza; rechaza solo espacios y caracteres nulos.
 *     RegisteredUser:
 *       type: object
 *       additionalProperties: false
 *       required: [id, name, email, created_at]
 *       properties:
 *         id:
 *           type: integer
 *         name:
 *           type: string
 *         email:
 *           type: string
 *           format: email
 *         created_at:
 *           type: string
 *           format: date-time
 *     RegistrationError:
 *       type: object
 *       additionalProperties: false
 *       required: [success, message]
 *       properties:
 *         success:
 *           type: boolean
 *           enum: [false]
 *         message:
 *           type: string
 *   responses:
 *     InvalidRegistration:
 *       description: Datos inválidos, JSON mal formado o cuerpo mayor de 4 KiB.
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RegistrationError'
 *     DuplicateRegistration:
 *       description: El correo ya está registrado.
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RegistrationError'
 *     LimitedRegistration:
 *       description: Se superaron 10 intentos por IP en 15 minutos.
 *       headers:
 *         Retry-After:
 *           description: Segundos hasta que se puede reintentar.
 *           schema:
 *             type: integer
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RegistrationError'
 *     FailedRegistration:
 *       description: Error interno; no se exponen detalles técnicos.
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RegistrationError'
 * /api/auth/register:
 *   post:
 *     summary: Registrar una cuenta
 *     description: Crea el usuario con contraseña protegida mediante bcrypt. No inicia sesión ni emite tokens. Los intentos válidos e inválidos comparten el límite por IP (subred /56 para IPv6).
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RegisterInput'
 *     responses:
 *       201:
 *         description: Usuario creado.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: false
 *               required: [success, data]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   enum: [true]
 *                 data:
 *                   $ref: '#/components/schemas/RegisteredUser'
 *       400:
 *         $ref: '#/components/responses/InvalidRegistration'
 *       409:
 *         $ref: '#/components/responses/DuplicateRegistration'
 *       429:
 *         $ref: '#/components/responses/LimitedRegistration'
 *       500:
 *         $ref: '#/components/responses/FailedRegistration'
 */
function createAuthRouter(authService) {
  const router = Router();
  const controller = createAuthController(authService);
  router.post('/register', requestContext, createRegisterRateLimit(),
    json({ limit: '4kb', inflate: false }), validateRegister, controller.register);
  return router;
}

module.exports = createAuthRouter;
