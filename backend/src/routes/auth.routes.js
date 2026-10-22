const { Router, json } = require('express');
const createAuthController = require('../controllers/auth.controller');
const validateRegister = require('../middlewares/validate-register');
const createRegisterRateLimit = require('../middlewares/register-rate-limit');
const requestContext = require('../middlewares/request-context');
const validateLogin = require('../middlewares/validate-login');
const createAuthenticate = require('../middlewares/authenticate');
const createValidateAuthOrigin = require('../middlewares/validate-auth-origin');

function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

/**
 * @swagger
 * components:
 *   securitySchemes:
 *     bearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 *       description: JWT HS256 de 15 minutos; se comprueba también la sesión activa en PostgreSQL.
 *     refreshCookie:
 *       type: apiKey
 *       in: cookie
 *       name: bitlearn_refresh
 *       description: Cookie HttpOnly, SameSite=Strict, Secure por defecto, Path=/api/auth. El navegador la envía; JavaScript no puede leerla.
 *   schemas:
 *     RefreshResult:
 *       type: object
 *       additionalProperties: false
 *       required: [success, data]
 *       properties:
 *         success:
 *           type: boolean
 *           enum: [true]
 *         data:
 *           type: object
 *           additionalProperties: false
 *           required: [accessToken, expiresIn]
 *           properties:
 *             accessToken:
 *               type: string
 *             expiresIn:
 *               type: integer
 *               enum: [900]
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
 *     LoginInput:
 *       type: object
 *       additionalProperties: false
 *       required: [email, password]
 *       properties:
 *         email:
 *           type: string
 *           format: email
 *           maxLength: 150
 *           description: Espacios exteriores recortados y minúsculas, igual que registro.
 *         password:
 *           type: string
 *           format: password
 *           writeOnly: true
 *           minLength: 1
 *           maxLength: 72
 *           description: De 1 a 72 bytes UTF-8, sin caracteres nulos. No se recorta ni normaliza.
 *     LoginResult:
 *       type: object
 *       additionalProperties: false
 *       required: [success, data]
 *       properties:
 *         success:
 *           type: boolean
 *           enum: [true]
 *         data:
 *           type: object
 *           additionalProperties: false
 *           required: [user, accessToken, expiresIn]
 *           properties:
 *             user:
 *               type: object
 *               additionalProperties: false
 *               required: [id, name, email]
 *               properties:
 *                 id:
 *                   type: integer
 *                 name:
 *                   type: string
 *                 email:
 *                   type: string
 *                   format: email
 *             accessToken:
 *               type: string
 *               description: JWT HS256 de 15 minutos, con sub, sid, iat, exp, iss y aud. Mantener exclusivamente en memoria del cliente.
 *             expiresIn:
 *               type: integer
 *               enum: [900]
 *   responses:
 *     InvalidSession:
 *       description: Token ausente, mal formado, desconocido, expirado o utilizado; sesión expirada, revocada o ajena. Respuesta uniforme sin detalles. Refresh elimina la cookie.
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RegistrationError'
 *           example:
 *             success: false
 *             message: Sesión no válida.
 *     InvalidAuthOrigin:
 *       description: Origin no pertenece a AUTH_TRUSTED_ORIGINS o Fetch Metadata indica origen no permitido sin Origin. No modifica la sesión ni la cookie.
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RegistrationError'
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
 * /api/auth/login:
 *   post:
 *     summary: Iniciar sesión con credenciales
 *     description: Crea una sesión y guarda únicamente el hash SHA-256 del Refresh Token opaco. Sesión y Refresh Token expiran a los 7 días. El token original solo se entrega en cookie HttpOnly y se rota mediante refresh. Logout revoca únicamente esta sesión. Origin, cuando esté presente, debe pertenecer a AUTH_TRUSTED_ORIGINS. Las respuestas no se deben almacenar en caché.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LoginInput'
 *     responses:
 *       200:
 *         description: Sesión confirmada en PostgreSQL y Access Token emitido.
 *         headers:
 *           Set-Cookie:
 *             description: bitlearn_refresh opaco; HttpOnly; SameSite=Strict; Secure por defecto y obligatorio en producción/Codespaces; Path=/api/auth; sin Domain. Max-Age descuenta el tiempo transcurrido para no superar la expiración de PostgreSQL (máximo 604800 segundos). Excepción solo para desarrollo HTTP local explícito.
 *             schema:
 *               type: string
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum: [no-store]
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LoginResult'
 *       400:
 *         description: Credenciales con formato inválido, campos adicionales, JSON inválido, cuerpo mayor de 4 KiB u origen no permitido.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RegistrationError'
 *       401:
 *         description: Credenciales incorrectas, sin distinguir correo inexistente de contraseña incorrecta.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RegistrationError'
 *             example:
 *               success: false
 *               message: Credenciales incorrectas.
 *       429:
 *         description: Más de 20 intentos en 15 minutos por IP (subred /56 IPv6), incluidos éxitos y datos inválidos. Tras un proxy no confiable se comparte su cuota.
 *         headers:
 *           Retry-After:
 *             schema:
 *               type: integer
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RegistrationError'
 *       500:
 *         $ref: '#/components/responses/FailedRegistration'
 * /api/auth/refresh:
 *   post:
 *     summary: Renovar credenciales de la sesión
 *     tags: [Auth]
 *     security:
 *       - refreshCookie: []
 *     description: Lee exclusivamente bitlearn_refresh de la cookie HttpOnly; ignora tokens en cuerpo, URL o encabezados personalizados. Consume el hash anterior e inserta uno nuevo en una transacción con bloqueo de sesión. Conserva el historial; reutilizar un token consumido confirma la revocación antes de responder 401. La sesión conserva su vencimiento original de 7 días. El frontend debe coordinar una sola renovación a la vez, incluso entre pestañas, porque solicitudes concurrentes pueden activar la revocación. Origin debe estar en AUTH_TRUSTED_ORIGINS si está presente. Todas las respuestas usan Cache-Control no-store.
 *     responses:
 *       200:
 *         description: Rotación confirmada; nuevo JWT de 900 segundos. El Refresh Token solo se entrega en cookie.
 *         headers:
 *           Set-Cookie:
 *             description: bitlearn_refresh nuevo; HttpOnly; SameSite=Strict; Secure por defecto; Path=/api/auth; sin Domain; Max-Age limitado al vencimiento original de la sesión.
 *             schema:
 *               type: string
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum: [no-store]
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RefreshResult'
 *       400:
 *         $ref: '#/components/responses/InvalidAuthOrigin'
 *       401:
 *         $ref: '#/components/responses/InvalidSession'
 *       429:
 *         description: Más de 60 intentos por IP en 15 minutos (subred /56 IPv6). Cuota en memoria por proceso; tras proxy no confiable se comparte la cuota. No modifica cookie ni sesión.
 *         headers:
 *           Retry-After:
 *             schema:
 *               type: integer
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RegistrationError'
 *       500:
 *         $ref: '#/components/responses/FailedRegistration'
 * /api/auth/logout:
 *   post:
 *     summary: Cerrar únicamente la sesión de la cookie
 *     tags: [Auth]
 *     security:
 *       - refreshCookie: []
 *       - {}
 *     description: Revoca la sesión identificada por el hash de la cookie, incluso si el token fue consumido. Conserva el historial y las demás sesiones. Idempotente sin cookie válida o con sesión ya revocada. Origin debe estar en AUTH_TRUSTED_ORIGINS si está presente. Todas las respuestas usan Cache-Control no-store. Un fallo de persistencia devuelve 500, aunque se limpia la cookie; no garantiza la revocación.
 *     responses:
 *       200:
 *         description: Cierre controlado; no revela si existía la sesión.
 *         headers:
 *           Set-Cookie:
 *             description: Elimina bitlearn_refresh con Path=/api/auth, HttpOnly, SameSite=Strict y las mismas reglas de Secure del login.
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: false
 *               required: [success, message]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   enum: [true]
 *                 message:
 *                   type: string
 *                   example: Sesión cerrada correctamente.
 *       400:
 *         $ref: '#/components/responses/InvalidAuthOrigin'
 *       500:
 *         $ref: '#/components/responses/FailedRegistration'
 * /api/auth/me:
 *   get:
 *     summary: Consultar la identidad autenticada
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     description: Solo Authorization Bearer; verifica firma HS256, exp, iat, iss, aud, sub y sid. Comprueba propiedad y vigencia de la sesión en PostgreSQL aunque el JWT no haya expirado. Devuelve exclusivamente el perfil público de sub; no admite seleccionar otro usuario. Todas las respuestas usan Cache-Control no-store. El JWT dura 15 minutos, pero deja de autorizar al revocar o expirar la sesión.
 *     responses:
 *       200:
 *         description: Perfil público de la identidad verificada.
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
 *       401:
 *         $ref: '#/components/responses/InvalidSession'
 *       500:
 *         $ref: '#/components/responses/FailedRegistration'
 */
function createAuthRouter(authService, config) {
  const router = Router();
  const controller = createAuthController(authService, config);
  const validateOrigin = createValidateAuthOrigin(config);
  router.post('/register', requestContext, createRegisterRateLimit(),
    json({ limit: '4kb', inflate: false }), validateRegister, controller.register);
  router.post('/login', requestContext, noStore, validateOrigin,
  createRegisterRateLimit({ limit: 20, action: 'inicio de sesión' }),
  json({ limit: '4kb', inflate: false }), validateLogin, controller.login);
  router.post('/refresh', requestContext, noStore, validateOrigin,
    createRegisterRateLimit({ limit: 60, action: 'renovación' }), controller.refresh);
  router.post('/logout', requestContext, noStore, validateOrigin, controller.logout);
  router.get('/me', requestContext, noStore, createAuthenticate(authService), controller.me);
  return router;
}

module.exports = createAuthRouter;
