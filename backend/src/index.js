require('dotenv').config();
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./config/swagger');
const healthRoutes = require('./routes/health.routes');
const pool = require('./config/db');
const createUserRepository = require('./repositories/user.repository');
const { createAuthService } = require('./services/auth.service');
const createAuthRouter = require('./routes/auth.routes');
const errorHandler = require('./middlewares/error-handler');
const loadAuthConfig = require('./config/auth');
const createSessionRepository = require('./repositories/session.repository');
const createTokenService = require('./services/token.service');
const createCourseRepository = require('./repositories/course.repository');
const { createCourseService } = require('./services/course.service');
const createCourseRouter = require('./routes/course.routes');

// Fallar antes de escuchar HTTP si faltan secretos o la configuración es insegura.
const authConfig = loadAuthConfig();

const app = express();
app.set('trust proxy', false);
const PORT = process.env.PORT || 3000;

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
// El router heredado de usuarios queda sin montar hasta contar con autenticación
// y autorización reales. El parser JSON se limita a las rutas de autenticación.
app.use('/api/health', healthRoutes);
app.use('/api/auth', createAuthRouter(createAuthService(createUserRepository(pool),
  createSessionRepository(pool), createTokenService(authConfig)), authConfig));
app.use('/api/courses', createCourseRouter(createCourseService(createCourseRepository(pool))));

app.get('/', (req, res) => {
  res.json({ message: 'API corriendo', docs: '/api-docs' });
});

app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Ruta no encontrada' });
});
app.use(errorHandler);

async function start() {
  try {
    app.listen(PORT, () => {
      console.log(`Servidor en http://localhost:${PORT}`);
      console.log(`Swagger en  http://localhost:${PORT}/api-docs`);
    });
  } catch (err) {
    console.error('Error al iniciar:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}

module.exports = app;
