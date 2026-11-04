/**
 * @swagger
 * /api/dashboard/retention:
 *   get:
 *     tags: [Dashboard]
 *     summary: Proyección matemática estimada de retención
 *     description: "Solo lectura, sin parámetros ni cuerpo. R(t)=exp(-t/S), S=max(1,I)/ln(2); t son días desde el último repaso e I el intervalo SM-2 almacenado. El 50 % al final del intervalo es ilustrativo, no validado ni calibrado individualmente. Promedio simple sin nuevos repasos; excluye tarjetas sin último repaso. SM-2 programa intervalos y no produce esta probabilidad."
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       '200':
 *         description: "Estimación o estado vacío (modeledCards 0, porcentajes y próxima fecha null, points vacío). Respuesta privada no-store con x-correlation-id."
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               additionalProperties: false
 *               properties:
 *                 success:
 *                   type: boolean
 *                   enum: [true]
 *                 data:
 *                   type: object
 *                   additionalProperties: false
 *                   required: [asOf, modeledCards, averageRetentionNowPercent, nextScheduledReviewAt, points]
 *                   properties:
 *                     asOf:
 *                       type: string
 *                       format: date-time
 *                       description: Referencia UTC de statement_timestamp() PostgreSQL.
 *                     modeledCards:
 *                       type: integer
 *                       minimum: 0
 *                     averageRetentionNowPercent:
 *                       type: number
 *                       minimum: 0
 *                       maximum: 100
 *                       nullable: true
 *                     nextScheduledReviewAt:
 *                       type: string
 *                       format: date-time
 *                       nullable: true
 *                       description: Próxima revisión estrictamente futura entre tarjetas estudiadas.
 *                     points:
 *                       type: array
 *                       items:
 *                         type: object
 *                         additionalProperties: false
 *                         required: [daysAhead, estimatedRetentionPercent]
 *                         properties:
 *                           daysAhead:
 *                             type: integer
 *                             enum: [0, 1, 3, 7, 14, 30]
 *                           estimatedRetentionPercent:
 *                             type: number
 *                             minimum: 0
 *                             maximum: 100
 *       '400':
 *         description: Parámetros o cuerpo no permitidos.
 *       '401':
 *         description: JWT o sesión no válidos.
 *       '500':
 *         description: Error interno seguro.
 *       '503':
 *         description: PostgreSQL no disponible.
 */
/**
 * @swagger
 * components:
 *   schemas:
 *     DashboardSummary:
 *       type: object
 *       additionalProperties: false
 *       required:
 *         - totalLessons
 *         - completedLessons
 *         - completionPercent
 *         - studiedFlashcards
 *         - dueReviews
 *         - totalReviews
 *       properties:
 *         totalLessons:
 *           type: integer
 *           minimum: 0
 *           maximum: 9007199254740991
 *           description: Total dinámico de lecciones del catálogo o curso.
 *         completedLessons:
 *           type: integer
 *           minimum: 0
 *           maximum: 9007199254740991
 *           description: Lecciones del usuario con completed_at no nulo; los intentos no
 *             cuentan.
 *         completionPercent:
 *           type: number
 *           minimum: 0
 *           maximum: 100
 *           description: Completadas / total * 100, redondeado a dos decimales; cero si no
 *             hay lecciones.
 *         studiedFlashcards:
 *           type: integer
 *           minimum: 0
 *           maximum: 9007199254740991
 *           description: Parejas usuario-tarjeta en user_card_progress; una por tarjeta
 *             estudiada mediante SM-2.
 *         dueReviews:
 *           type: integer
 *           minimum: 0
 *           maximum: 9007199254740991
 *           description: "Total sin paginación: nuevas de lecciones completadas sin estado,
 *             más estados vencidos según statement_timestamp() PostgreSQL; misma
 *             elegibilidad que GET /api/reviews/due."
 *         totalReviews:
 *           type: integer
 *           minimum: 0
 *           maximum: 9007199254740991
 *           description: Registros confirmados de card_reviews del usuario; los reenvíos
 *             idempotentes no agregan registros.
 *     DashboardCourse:
 *       type: object
 *       additionalProperties: false
 *       required:
 *         - courseId
 *         - courseSlug
 *         - courseTitle
 *         - totalLessons
 *         - completedLessons
 *         - completionPercent
 *       properties:
 *         courseId:
 *           type: integer
 *           minimum: 1
 *         courseSlug:
 *           type: string
 *         courseTitle:
 *           type: string
 *         totalLessons:
 *           type: integer
 *           minimum: 0
 *           maximum: 9007199254740991
 *           description: Total dinámico de lecciones del catálogo o curso.
 *         completedLessons:
 *           type: integer
 *           minimum: 0
 *           maximum: 9007199254740991
 *           description: Lecciones del usuario con completed_at no nulo; los intentos no
 *             cuentan.
 *         completionPercent:
 *           type: number
 *           minimum: 0
 *           maximum: 100
 *           description: Completadas / total * 100, redondeado a dos decimales; cero si no
 *             hay lecciones.
 *     DashboardData:
 *       type: object
 *       additionalProperties: false
 *       required:
 *         - summary
 *         - courses
 *       properties:
 *         summary:
 *           $ref: "#/components/schemas/DashboardSummary"
 *         courses:
 *           type: array
 *           items:
 *             $ref: "#/components/schemas/DashboardCourse"
 * /api/dashboard:
 *   get:
 *     summary: Consultar estadísticas personales de aprendizaje
 *     description: Solo lectura. No admite parámetros ni cuerpo. Identidad exclusiva
 *       del JWT y sesión activa. Una instantánea PostgreSQL; cursos ordenados por
 *       slug e ID, incluidos cursos sin progreso o sin lecciones. No ejecuta SM-2
 *       ni calcula retención. Valores del ejemplo ilustrativos.
 *     tags:
 *       - Dashboard
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       "200":
 *         description: Estadísticas reales; usuario sin actividad recibe ceros y todos los
 *           cursos.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum:
 *                 - no-store
 *           x-correlation-id:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: false
 *               required:
 *                 - success
 *                 - data
 *               properties:
 *                 success:
 *                   type: boolean
 *                   enum:
 *                     - true
 *                 data:
 *                   $ref: "#/components/schemas/DashboardData"
 *             example:
 *               success: true
 *               data:
 *                 summary:
 *                   totalLessons: 9
 *                   completedLessons: 4
 *                   completionPercent: 44.44
 *                   studiedFlashcards: 5
 *                   dueReviews: 3
 *                   totalReviews: 12
 *                 courses:
 *                   - courseId: 1
 *                     courseSlug: html
 *                     courseTitle: HTML
 *                     totalLessons: 3
 *                     completedLessons: 2
 *                     completionPercent: 66.67
 *                   - courseId: 2
 *                     courseSlug: css
 *                     courseTitle: CSS
 *                     totalLessons: 3
 *                     completedLessons: 1
 *                     completionPercent: 33.33
 *                   - courseId: 3
 *                     courseSlug: javascript
 *                     courseTitle: JavaScript
 *                     totalLessons: 3
 *                     completedLessons: 1
 *                     completionPercent: 33.33
 *       "400":
 *         description: Parámetros desconocidos o repetidos, userId o cuerpo no permitidos.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum:
 *                 - no-store
 *           x-correlation-id:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/CatalogError"
 *       "401":
 *         description: JWT ausente, inválido o expirado; sesión inactiva o revocada.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum:
 *                 - no-store
 *           x-correlation-id:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/CatalogError"
 *       "500":
 *         description: Error interno, sin detalles sensibles.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum:
 *                 - no-store
 *           x-correlation-id:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/CatalogError"
 *       "503":
 *         description: PostgreSQL temporalmente no disponible; sin datos ficticios.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum:
 *                 - no-store
 *           x-correlation-id:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/CatalogError"
 */
const { Router } = require('express');
const { z } = require('zod');
const createController = require('../controllers/dashboard.controller');
const createAuthenticate = require('../middlewares/authenticate');
const requestContext = require('../middlewares/request-context');
const isPostgresUnavailable = require('../config/postgres-errors');
const { DashboardUnavailableError } = require('../services/dashboard.service');
const emptyQuery = z.strictObject({});

function createDashboardRouter(service, authService) {
  const router = Router();
  router.use(requestContext, (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  for (const [path, method] of [['/', 'get'], ['/retention', 'getRetention']]) router.get(path, createAuthenticate(authService), (req, res, next) => {
    const params = new URLSearchParams(req.originalUrl.split('?')[1] || '');
    // No cuerpo, cualquiera que sea su Content-Type; tampoco identidades alternativas.
    const body = req.headers['transfer-encoding'] !== undefined
      || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0');
    if (body || !emptyQuery.safeParse(Object.fromEntries(params)).success) {
      return res.status(400).json({ success: false, message: 'La solicitud no admite parámetros ni cuerpo.' });
    }
    next();
  }, createController(service, method));
  router.use((error, req, res, next) => next(isPostgresUnavailable(error) ? new DashboardUnavailableError() : error));
  return router;
}
module.exports = createDashboardRouter;
