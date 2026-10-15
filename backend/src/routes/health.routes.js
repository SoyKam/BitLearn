const { Router } = require('express');
const HealthController = require('../controllers/health.controller');

const router = Router();

/**
 * @swagger
 * /api/health:
 *   get:
 *     summary: Verificar el estado de la API y la conexión a PostgreSQL
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: API y base de datos disponibles
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [status, database]
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [ok]
 *                 database:
 *                   type: string
 *                   enum: [connected]
 *       503:
 *         description: Base de datos no disponible
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [status, database]
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [unavailable]
 *                 database:
 *                   type: string
 *                   enum: [disconnected]
 */
router.get('/', HealthController.getStatus);

module.exports = router;
