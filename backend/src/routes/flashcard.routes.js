const { Router } = require('express');
const createFlashcardController = require('../controllers/flashcard.controller');
const requestContext = require('../middlewares/request-context');

/**
 * @swagger
 * components:
 *   schemas:
 *     Flashcard:
 *       type: object
 *       additionalProperties: false
 *       required: [id, lessonId, lessonTitle, position, front, back]
 *       properties:
 *         id:
 *           type: integer
 *         lessonId:
 *           type: integer
 *         lessonTitle:
 *           type: string
 *         position:
 *           type: integer
 *           minimum: 1
 *         front:
 *           type: string
 *         back:
 *           type: string
 * /api/flashcards:
 *   get:
 *     summary: Consultar flashcards de un curso
 *     description: Acceso público sin JWT. Contenido compartido ordenado por unidad, lección y posición. Devuelve ambos lados, sin progreso personal ni historial. Solo admite el parámetro course, una vez. No escribe ni crea estados SM-2.
 *     tags: [Flashcards]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: course
 *         required: true
 *         schema:
 *           type: string
 *           minLength: 1
 *           maxLength: 150
 *           pattern: '^[a-z0-9]+(-[a-z0-9]+)*$'
 *         example: html
 *     responses:
 *       200:
 *         description: Tarjetas del curso; data vacío si existe pero no tiene tarjetas.
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
 *                     $ref: '#/components/schemas/Flashcard'
 *             example:
 *               success: true
 *               data:
 *                 - id: 1
 *                   lessonId: 1
 *                   lessonTitle: Estructura básica de HTML
 *                   position: 1
 *                   front: ¿Qué propósito tiene <!doctype html> al inicio del documento?
 *                   back: Indica HTML moderno y activa el modo estándar del navegador.
 *       400:
 *         description: course ausente, repetido o inválido, o parámetros adicionales.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *       404:
 *         description: Curso no encontrado.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *       500:
 *         description: Error interno sin detalles técnicos.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *       503:
 *         description: Servicio temporalmente no disponible, sin detalles de conexión.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 */
function createFlashcardRouter(service) {
  const router = Router();
  router.use(requestContext);
  router.get('/', createFlashcardController(service).list);
  return router;
}
module.exports = createFlashcardRouter;
