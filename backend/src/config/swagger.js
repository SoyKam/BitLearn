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
  apis: ['health.routes.js', 'auth.routes.js'].map((file) => path.join(__dirname, '../routes', file)),
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;
