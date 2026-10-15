const HealthRepository = require('../repositories/health.repository');

const HealthController = {
  async getStatus(req, res) {
    try {
      await HealthRepository.checkConnection();
      res.status(200).json({ status: 'ok', database: 'connected' });
    } catch {
      res.status(503).json({ status: 'unavailable', database: 'disconnected' });
    }
  },
};

module.exports = HealthController;
