const { Router } = require('express');
const createCourseController = require('../controllers/course.controller');
const requestContext = require('../middlewares/request-context');

/**
 * @swagger
 * components:
 *   schemas:
 *     Course:
 *       type: object
 *       additionalProperties: false
 *       required: [id, title, slug, description]
 *       properties:
 *         id:
 *           type: integer
 *         title:
 *           type: string
 *           maxLength: 150
 *         slug:
 *           type: string
 *           maxLength: 150
 *           pattern: '^[a-z0-9]+(-[a-z0-9]+)*$'
 *         description:
 *           type: string
 *           nullable: true
 *     CatalogError:
 *       type: object
 *       additionalProperties: false
 *       required: [success, message]
 *       properties:
 *         success:
 *           type: boolean
 *           enum: [false]
 *         message:
 *           type: string
 * /api/courses:
 *   get:
 *     summary: Consultar el catálogo de cursos
 *     description: Consulta pública de solo lectura en PostgreSQL, sin iniciar sesión. Devuelve únicamente información general, ordenada por title ASC e id ASC. No incluye unidades ni lecciones ni carga el seed automáticamente.
 *     tags: [Courses]
 *     security: []
 *     responses:
 *       200:
 *         description: Catálogo disponible; data es un arreglo vacío si no existen cursos.
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
 *                     $ref: '#/components/schemas/Course'
 *             examples:
 *               empty:
 *                 summary: Catálogo vacío
 *                 value: { success: true, data: [] }
 *       500:
 *         description: Error interno no clasificado; sin detalles técnicos.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *             example: { success: false, message: 'No se pudo completar la solicitud.' }
 *       503:
 *         description: Indisponibilidad identificable de PostgreSQL; sin detalles de conexión.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *             example: { success: false, message: 'El catálogo no está disponible temporalmente.' }
 */
function createCourseRouter(courseService) {
  const router = Router();
  const controller = createCourseController(courseService);
  router.get('/', requestContext, controller.list);
  return router;
}

module.exports = createCourseRouter;
