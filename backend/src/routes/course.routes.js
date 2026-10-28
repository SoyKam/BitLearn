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
 *     CourseDetail:
 *       type: object
 *       additionalProperties: false
 *       required: [id, title, slug, description, units]
 *       properties:
 *         id:
 *           type: integer
 *         title:
 *           type: string
 *           maxLength: 150
 *         slug:
 *           type: string
 *           minLength: 1
 *           maxLength: 150
 *           pattern: '^[a-z0-9]+(-[a-z0-9]+)*$'
 *         description:
 *           type: string
 *           nullable: true
 *         units:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/CourseUnit'
 *     CourseUnit:
 *       type: object
 *       additionalProperties: false
 *       required: [id, title, position, lessons]
 *       properties:
 *         id:
 *           type: integer
 *         title:
 *           type: string
 *         position:
 *           type: integer
 *           minimum: 1
 *         lessons:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/CourseLesson'
 *     CourseLesson:
 *       type: object
 *       additionalProperties: false
 *       required: [id, title, position]
 *       properties:
 *         id:
 *           type: integer
 *         title:
 *           type: string
 *         position:
 *           type: integer
 *           minimum: 1
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
 * /api/courses/{slug}:
 *   get:
 *     summary: Consultar unidades y lecciones de un curso
 *     description: Consulta pública de solo lectura en PostgreSQL. Devuelve el curso y sus unidades y lecciones ordenadas por position ascendente dentro de su padre, sin content. Las colecciones vacías se representan con arreglos vacíos. No carga seeds automáticamente.
 *     tags: [Courses]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         description: Slug canónico del curso, sin normalización automática.
 *         schema:
 *           type: string
 *           minLength: 1
 *           maxLength: 150
 *           pattern: '^[a-z0-9]+(-[a-z0-9]+)*$'
 *         example: html
 *     responses:
 *       200:
 *         description: Curso con sus unidades y lecciones, sin contenido completo.
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
 *                   $ref: '#/components/schemas/CourseDetail'
 *       400:
 *         description: Slug inválido.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *             example: { success: false, message: 'Slug de curso inválido.' }
 *       404:
 *         description: Slug válido sin curso asociado.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *             example: { success: false, message: 'Curso no encontrado.' }
 *       500:
 *         description: Error interno sin detalles técnicos.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CatalogError'
 *             example: { success: false, message: 'No se pudo completar la solicitud.' }
 *       503:
 *         description: Indisponibilidad identificable de PostgreSQL.
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
  router.get('/:slug', requestContext, controller.detail);
  router.use((error, req, res, next) => {
    // Express decodifica el parámetro antes de llegar al controlador.
    if (error instanceof URIError && error.status === 400) {
      return res.status(400).json({ success: false, message: 'Slug de curso inválido.' });
    }
    next(error);
  });
  return router;
}

module.exports = createCourseRouter;
