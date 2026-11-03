/**
 * @swagger
 * components:
 *   schemas:
 *     LessonProgress:
 *       type: object
 *       additionalProperties: false
 *       required:
 *       - attempts
 *       - correctAnswers
 *       - completedAt
 *       properties:
 *         attempts:
 *           type: integer
 *           minimum: 0
 *         correctAnswers:
 *           type: integer
 *           minimum: 0
 *         completedAt:
 *           type: string
 *           format: date-time
 *           nullable: true
 *     LessonQuestion:
 *       type: object
 *       additionalProperties: false
 *       required:
 *       - id
 *       - prompt
 *       - options
 *       properties:
 *         id:
 *           type: integer
 *           minimum: 1
 *           maximum: 2147483647
 *         prompt:
 *           type: string
 *         options:
 *           type: array
 *           minItems: 2
 *           maxItems: 6
 *           items:
 *             type: string
 *             minLength: 1
 *     LessonDetail:
 *       type: object
 *       additionalProperties: false
 *       required:
 *       - id
 *       - title
 *       - content
 *       - course
 *       - unit
 *       - questions
 *       properties:
 *         id:
 *           type: integer
 *           minimum: 1
 *           maximum: 2147483647
 *         title:
 *           type: string
 *         content:
 *           type: string
 *           nullable: true
 *         course:
 *           type: object
 *           additionalProperties: false
 *           required:
 *           - id
 *           - title
 *           - slug
 *           properties:
 *             id:
 *               type: integer
 *               minimum: 1
 *               maximum: 2147483647
 *             title:
 *               type: string
 *             slug:
 *               type: string
 *         unit:
 *           type: object
 *           additionalProperties: false
 *           required:
 *           - id
 *           - title
 *           properties:
 *             id:
 *               type: integer
 *               minimum: 1
 *               maximum: 2147483647
 *             title:
 *               type: string
 *         questions:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/LessonQuestion'
 *     LessonAnswer:
 *       type: object
 *       additionalProperties: false
 *       required:
 *       - questionId
 *       - optionIndex
 *       properties:
 *         questionId:
 *           type: integer
 *           minimum: 1
 *           maximum: 2147483647
 *         optionIndex:
 *           type: integer
 *           minimum: 0
 *           maximum: 5
 *     LessonAnswerResult:
 *       type: object
 *       additionalProperties: false
 *       required:
 *       - correct
 *       - completed
 *       - explanation
 *       - progress
 *       properties:
 *         correct:
 *           type: boolean
 *         completed:
 *           type: boolean
 *         explanation:
 *           type: string
 *           nullable: true
 *         progress:
 *           $ref: '#/components/schemas/LessonProgress'
 *     PersonalProgress:
 *       type: object
 *       additionalProperties: false
 *       required:
 *       - completedLessons
 *       - totalLessons
 *       - lessons
 *       properties:
 *         completedLessons:
 *           type: integer
 *           minimum: 0
 *         totalLessons:
 *           type: integer
 *           minimum: 0
 *         lessons:
 *           type: array
 *           items:
 *             type: object
 *             additionalProperties: false
 *             required:
 *             - lessonId
 *             - courseSlug
 *             - attempts
 *             - correctAnswers
 *             - completedAt
 *             properties:
 *               lessonId:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 2147483647
 *               courseSlug:
 *                 type: string
 *               attempts:
 *                 type: integer
 *                 minimum: 0
 *               correctAnswers:
 *                 type: integer
 *                 minimum: 0
 *               completedAt:
 *                 type: string
 *                 format: date-time
 *                 nullable: true
 * /api/lessons/{id}:
 *   get:
 *     summary: Consultar una lección
 *     description: Consulta pública con curso, unidad y preguntas por position. Sin solución ni explanation. Admite
 *       cero preguntas; no crea contenido.
 *     tags:
 *     - Learning
 *     security: []
 *     responses:
 *       '200':
 *         description: Operación completada.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: false
 *               required:
 *               - success
 *               - data
 *               properties:
 *                 success:
 *                   type: boolean
 *                   enum:
 *                   - true
 *                 data:
 *                   $ref: '#/components/schemas/LessonDetail'
 *         headers:
 *           x-correlation-id:
 *             description: Identificador de solicitud generado por el servidor.
 *             schema:
 *               type: string
 *       '400':
 *         description: ID, JSON u opción inválidos; campos adicionales o cuerpo mayor de 4 KiB.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *         headers:
 *           x-correlation-id:
 *             description: Identificador de solicitud generado por el servidor.
 *             schema:
 *               type: string
 *       '404':
 *         description: Lección o pregunta inexistente, o pregunta de otra lección.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *         headers:
 *           x-correlation-id:
 *             description: Identificador de solicitud generado por el servidor.
 *             schema:
 *               type: string
 *       '500':
 *         description: Error interno sin detalles técnicos.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *         headers:
 *           x-correlation-id:
 *             description: Identificador de solicitud generado por el servidor.
 *             schema:
 *               type: string
 *       '503':
 *         description: Indisponibilidad identificable de PostgreSQL.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *         headers:
 *           x-correlation-id:
 *             description: Identificador de solicitud generado por el servidor.
 *             schema:
 *               type: string
 *     parameters:
 *     - name: id
 *       required: true
 *       in: path
 *       description: Entero positivo decimal sin signo ni espacios, hasta 2147483647.
 *       schema:
 *         type: string
 *         pattern: ^[0-9]+$
 *         minLength: 1
 *         maxLength: 10
 * /api/lessons/{id}/answer:
 *   post:
 *     summary: Responder una pregunta
 *     description: Evalúa en el servidor y registra un intento por cada solicitud válida confirmada, incluidos reintentos
 *       HTTP. Un acierto completa la lección y conserva la primera fecha. MVP con una pregunta inicial por lección;
 *       no verifica dominio de todas las preguntas. El cliente debe impedir envíos duplicados. Sin SM-2. Identidad
 *       exclusivamente del JWT y sesión activa.
 *     tags:
 *     - Learning
 *     security:
 *     - bearerAuth: []
 *     responses:
 *       '200':
 *         description: Operación completada.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: false
 *               required:
 *               - success
 *               - data
 *               properties:
 *                 success:
 *                   type: boolean
 *                   enum:
 *                   - true
 *                 data:
 *                   $ref: '#/components/schemas/LessonAnswerResult'
 *         headers:
 *           x-correlation-id:
 *             description: Identificador de solicitud generado por el servidor.
 *             schema:
 *               type: string
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum:
 *               - no-store
 *       '400':
 *         description: ID, JSON u opción inválidos; campos adicionales o cuerpo mayor de 4 KiB.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *         headers:
 *           x-correlation-id:
 *             description: Identificador de solicitud generado por el servidor.
 *             schema:
 *               type: string
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum:
 *               - no-store
 *       '401':
 *         description: JWT ausente, inválido o expirado; sesión inactiva, revocada o ajena.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *         headers:
 *           x-correlation-id:
 *             description: Identificador de solicitud generado por el servidor.
 *             schema:
 *               type: string
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum:
 *               - no-store
 *       '404':
 *         description: Lección o pregunta inexistente, o pregunta de otra lección.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *         headers:
 *           x-correlation-id:
 *             description: Identificador de solicitud generado por el servidor.
 *             schema:
 *               type: string
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum:
 *               - no-store
 *       '429':
 *         description: Más de 60 intentos por IP en 15 minutos (subred /56 IPv6); cuota en memoria por proceso compartida
 *           tras proxy no confiable.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *         headers:
 *           x-correlation-id:
 *             description: Identificador de solicitud generado por el servidor.
 *             schema:
 *               type: string
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum:
 *               - no-store
 *           Retry-After:
 *             schema:
 *               type: integer
 *               minimum: 0
 *       '500':
 *         description: Error interno sin detalles técnicos.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *         headers:
 *           x-correlation-id:
 *             description: Identificador de solicitud generado por el servidor.
 *             schema:
 *               type: string
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum:
 *               - no-store
 *       '503':
 *         description: Indisponibilidad identificable de PostgreSQL.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *         headers:
 *           x-correlation-id:
 *             description: Identificador de solicitud generado por el servidor.
 *             schema:
 *               type: string
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum:
 *               - no-store
 *     parameters:
 *     - name: id
 *       required: true
 *       in: path
 *       description: Entero positivo decimal sin signo ni espacios, hasta 2147483647.
 *       schema:
 *         type: string
 *         pattern: ^[0-9]+$
 *         minLength: 1
 *         maxLength: 10
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LessonAnswer'
 */const { Router, json } = require('express');
const { createLessonController, validateLessonId } = require('../controllers/lesson.controller');
const createAuthenticate = require('../middlewares/authenticate');
const requestContext = require('../middlewares/request-context');
const createRateLimit = require('../middlewares/register-rate-limit');
const isPostgresUnavailable = require('../config/postgres-errors');
const { LearningInputError, LearningUnavailableError } = require('../services/lesson.service');

function createLessonRouter(service, authService) {
  const router = Router();
  const controller = createLessonController(service);
  router.use(requestContext);
  // Antes de resolver parámetros, también para errores de decodificación.
  router.use((req, res, next) => {
    if (req.method === 'POST') res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/:id', validateLessonId, controller.detail);
  router.post('/:id/answer', createRateLimit({ limit: 60, action: 'respuesta' }),
    createAuthenticate(authService), validateLessonId,
    json({ limit: '4kb', inflate: false }), controller.answer);
  router.use((error, req, res, next) => {
    if (isPostgresUnavailable(error)) return next(new LearningUnavailableError());
    next(error instanceof URIError && error.status === 400 ? new LearningInputError() : error);
  });
  return router;
}
module.exports = createLessonRouter;
