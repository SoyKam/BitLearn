/**
 * @swagger
 * components:
 *   schemas:
 *     DueReview:
 *       type: object
 *       additionalProperties: false
 *       required: [flashcardId, lessonId, lessonTitle, courseSlug, front, back, status, repetitions, easeFactor, intervalDays, lastReviewAt, nextReviewAt]
 *       properties:
 *         flashcardId:
 *           type: integer
 *         lessonId:
 *           type: integer
 *         lessonTitle:
 *           type: string
 *         courseSlug:
 *           type: string
 *         front:
 *           type: string
 *         back:
 *           type: string
 *         status:
 *           type: string
 *           enum: [new, due]
 *         repetitions:
 *           type: integer
 *         easeFactor:
 *           type: number
 *         intervalDays:
 *           type: integer
 *         lastReviewAt:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         nextReviewAt:
 *           type: string
 *           format: date-time
 *           nullable: true
 *     ReviewHistoryItem:
 *       type: object
 *       additionalProperties: false
 *       required: [reviewId, flashcardId, courseSlug, lessonTitle, front, quality, reviewedAt, easeFactorBefore, easeFactorAfter, intervalBeforeDays, intervalAfterDays, nextReviewAt]
 *       properties:
 *         reviewId:
 *           type: string
 *         flashcardId:
 *           type: integer
 *         courseSlug:
 *           type: string
 *         lessonTitle:
 *           type: string
 *         front:
 *           type: string
 *         quality:
 *           type: integer
 *         reviewedAt:
 *           type: string
 *           format: date-time
 *         easeFactorBefore:
 *           type: number
 *         easeFactorAfter:
 *           type: number
 *         intervalBeforeDays:
 *           type: integer
 *         intervalAfterDays:
 *           type: integer
 *         nextReviewAt:
 *           type: string
 *           format: date-time
 * /api/reviews/due:
 *   get:
 *     summary: Consultar repasos pendientes
 *     description: Tarjetas vencidas primero por fecha ascendente; después nuevas de lecciones completadas sin estado. Desempate por curso, unidad, lección, posición e ID. new representa 0 repeticiones, factor 2.5, intervalo 0 y fechas null sin insertar estado. due devuelve estado persistido cuya fecha es menor o igual al instante de PostgreSQL. No ejecuta SM-2. Solo admite los parámetros documentados una vez; rechaza userId y parámetros desconocidos.
 *     tags: [Reviews]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         required: false
 *         description: Entero decimal sin signo, espacios, fracciones ni exponentes.
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *     responses:
 *       200:
 *         description: Consulta exitosa; sin registros devuelve data [] en pendientes o items [], total 0 en historial. Una página fuera de rango conserva el total real.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum: [no-store]
 *           x-correlation-id:
 *             schema:
 *               type: string
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
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/DueReview'
 *       400:
 *         description: Parámetros inválidos, repetidos o desconocidos.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum: [no-store]
 *           x-correlation-id:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *       401:
 *         description: JWT ausente, inválido o expirado; sesión revocada o inactiva.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum: [no-store]
 *           x-correlation-id:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *       500:
 *         description: Error interno sin información sensible.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum: [no-store]
 *           x-correlation-id:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *       503:
 *         description: PostgreSQL temporalmente no disponible.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum: [no-store]
 *           x-correlation-id:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 * /api/reviews/history:
 *   get:
 *     summary: Consultar historial personal
 *     description: Historial propio ordenado por reviewed_at DESC e id DESC. Total independiente de la página y obtenido en la misma instantánea. Nuevos repasos pueden desplazar páginas entre solicitudes; offset no garantiza una instantánea inmutable. No recalcula SM-2. Solo admite los parámetros documentados una vez; rechaza userId y parámetros desconocidos.
 *     tags: [Reviews]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         required: false
 *         description: Entero decimal sin signo, espacios, fracciones ni exponentes.
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *       - in: query
 *         name: offset
 *         required: false
 *         description: Entero decimal sin signo, espacios, fracciones ni exponentes.
 *         schema:
 *           type: integer
 *           minimum: 0
 *           maximum: 10000
 *           default: 0
 *     responses:
 *       200:
 *         description: Consulta exitosa; sin registros devuelve data [] en pendientes o items [], total 0 en historial. Una página fuera de rango conserva el total real.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum: [no-store]
 *           x-correlation-id:
 *             schema:
 *               type: string
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
 *                   type: object
 *                   additionalProperties: false
 *                   required: [items, total, limit, offset]
 *                   properties:
 *                     items:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/ReviewHistoryItem'
 *                     total:
 *                       type: integer
 *                       minimum: 0
 *                     limit:
 *                       type: integer
 *                     offset:
 *                       type: integer
 *       400:
 *         description: Parámetros inválidos, repetidos o desconocidos.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum: [no-store]
 *           x-correlation-id:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *       401:
 *         description: JWT ausente, inválido o expirado; sesión revocada o inactiva.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum: [no-store]
 *           x-correlation-id:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *       500:
 *         description: Error interno sin información sensible.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum: [no-store]
 *           x-correlation-id:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *       503:
 *         description: PostgreSQL temporalmente no disponible.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum: [no-store]
 *           x-correlation-id:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 */
/**
 * @swagger
 * components:
 *   schemas:
 *     ReviewInput:
 *       type: object
 *       additionalProperties: false
 *       required: [flashcardId, quality, requestId]
 *       properties:
 *         flashcardId:
 *           type: integer
 *           minimum: 1
 *           maximum: 2147483647
 *         quality:
 *           type: integer
 *           minimum: 0
 *           maximum: 5
 *           description: "0 nada, 1 muy poco, 2 insuficiente, 3 con dificultad, 4 correcto, 5 fácil."
 *         requestId:
 *           type: string
 *           format: uuid
 *           description: UUID v4 obligatorio para una operación concreta.
 *     ReviewResult:
 *       type: object
 *       additionalProperties: false
 *       required: [reviewId, flashcardId, quality, easeFactor, intervalDays, reviewedAt, nextReviewAt, replayed]
 *       properties:
 *         reviewId:
 *           type: string
 *         flashcardId:
 *           type: integer
 *         quality:
 *           type: integer
 *         easeFactor:
 *           type: number
 *         intervalDays:
 *           type: integer
 *         reviewedAt:
 *           type: string
 *           format: date-time
 *         nextReviewAt:
 *           type: string
 *           format: date-time
 *         replayed:
 *           type: boolean
 *           description: true si recupera el resultado histórico sin recalcular SM-2.
 * /api/reviews:
 *   post:
 *     summary: Registrar un repaso transaccional con SM-2
 *     description: >
 *       Requiere JWT y sesión activa. No enviar userId; la identidad procede exclusivamente
 *       de la sesión. Activa la tarjeta solo con su lección completada. Una tarjeta activada
 *       admite nuevos repasos cuando next_review_at es menor o igual al instante del servidor.
 *       SM-2 calcula factor, repeticiones, intervalo y fechas; estado e historial se confirman
 *       juntos bajo bloqueo por usuario y tarjeta. requestId es único por usuario; un reenvío
 *       idéntico devuelve los valores originales incluso si la tarjeta aún no está pendiente.
 *       Reutilizarlo con otra calidad o tarjeta produce 409. JSON máximo de 4 KiB.
 *     tags: [Reviews]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ReviewInput'
 *     responses:
 *       200:
 *         description: Repaso confirmado o reproducción idempotente.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum: [no-store]
 *           x-correlation-id:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   enum: [true]
 *                 data:
 *                   $ref: '#/components/schemas/ReviewResult'
 *       400:
 *         description: JSON inválido, campos adicionales, tipos incorrectos o cuerpo mayor de 4 KiB.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum: [no-store]
 *           x-correlation-id:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *       401:
 *         description: JWT ausente, inválido o expirado; sesión revocada o inactiva.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum: [no-store]
 *           x-correlation-id:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *       403:
 *         description: Lección sin completar antes de activar la tarjeta.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum: [no-store]
 *           x-correlation-id:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *       404:
 *         description: Flashcard inexistente.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum: [no-store]
 *           x-correlation-id:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *       409:
 *         description: requestId reutilizado con otros datos o tarjeta no pendiente.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum: [no-store]
 *           x-correlation-id:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *       429:
 *         description: Más de 60 intentos por IP en 15 minutos; memoria por proceso, subred IPv6 /56.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum: [no-store]
 *           x-correlation-id:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *       500:
 *         description: Error interno sin detalles sensibles.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum: [no-store]
 *           x-correlation-id:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *       503:
 *         description: PostgreSQL temporalmente no disponible.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum: [no-store]
 *           x-correlation-id:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 */
const { Router, json } = require('express');
const { z } = require('zod');
const createController = require('../controllers/review.controller');
const createAuthenticate = require('../middlewares/authenticate');
const requestContext = require('../middlewares/request-context');
const createRateLimit = require('../middlewares/register-rate-limit');
const isPostgresUnavailable = require('../config/postgres-errors');
const { ReviewsUnavailableError } = require('../services/review.service');

const schema = z.strictObject({
  flashcardId: z.number().int().positive().max(2147483647),
  quality: z.number().int().min(0).max(5),
  requestId: z.uuidv4(),
});
const decimal = (min, max, fallback) => z.string().regex(/^[0-9]+$/)
  .transform(Number).pipe(z.number().int().min(min).max(max)).default(fallback);
const dueQuery = z.strictObject({ limit: decimal(1, 100, 50) });
const historyQuery = z.strictObject({ limit: decimal(1, 100, 20), offset: decimal(0, 10000, 0) });
function validateQuery(schema) {
  return (req, res, next) => {
    // Leer la URL conserva repeticiones incluso si cambia el parser de Express.
    const params = new URLSearchParams(req.originalUrl.split('?')[1] || '');
    const repeated = [...params.keys()].some(key => params.getAll(key).length !== 1);
    const parsed = schema.safeParse(Object.fromEntries(params));
    if (repeated || !parsed.success) {
      return res.status(400).json({ success: false, message: 'Parámetros de consulta inválidos.' });
    }
    req.reviewQuery = parsed.data;
    next();
  };
}
function createReviewRouter(service, authService) {
  const router = Router();
  router.use(requestContext);
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const controller = createController(service);
  router.get('/due', createAuthenticate(authService), validateQuery(dueQuery), controller.due);
  router.get('/history', createAuthenticate(authService), validateQuery(historyQuery), controller.history);
  router.post('/', createRateLimit({ limit: 60, action: 'repaso' }), createAuthenticate(authService),
    json({ limit: '4kb', inflate: false }), (req, res, next) => {
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ success: false, message: 'Datos de repaso inválidos.' });
      req.body = parsed.data;
      next();
    }, createController(service).record);
  router.use((error, req, res, next) => next(isPostgresUnavailable(error) ? new ReviewsUnavailableError() : error));
  return router;
}
module.exports = createReviewRouter;
