const swaggerJsdoc = require('swagger-jsdoc');
const path = require('node:path');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'BackWeb API',
      version: '1.0.0',
      description: 'API REST con Express y PostgreSQL',
    },
    servers: [
      {
        url: `http://localhost:${process.env.PORT || 3000}`,
        description: 'Servidor local',
      },
    ],
  },
  // Documentar solo routers públicos activos; el de usuarios sigue deshabilitado.
  apis: [path.join(__dirname, '../routes/health.routes.js')],
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;
