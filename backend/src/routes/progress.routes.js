/**
 * @swagger
 * /api/progress:
 *   get:
 *     summary: Consultar el progreso personal
 *     description: Solo progreso del usuario autenticado. Total de lecciones calculado desde PostgreSQL. Omite lecciones
 *       sin progreso; orden por slug de curso, posición de unidad, posición e ID de lección. Sin respuestas previas
 *       devuelve lessons vacío y completedLessons cero. No admite seleccionar otro usuario.
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
 *                   $ref: '#/components/schemas/PersonalProgress'
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
 */const { LearningUnavailableError } = require('../services/lesson.service');
const isPostgresUnavailable = require('../config/postgres-errors');
const { Router } = require('express');
const createProgressController = require('../controllers/progress.controller');
const createAuthenticate = require('../middlewares/authenticate');
const requestContext = require('../middlewares/request-context');

function createProgressRouter(service, authService) {
  const router = Router();
  router.use(requestContext, (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/', createAuthenticate(authService), createProgressController(service));
  router.use((error, req, res, next) => {
    next(isPostgresUnavailable(error) ? new LearningUnavailableError() : error);
  });
  return router;
}
module.exports = createProgressRouter;
