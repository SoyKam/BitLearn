function createDashboardController(service, method = 'get') {
  return async function get(req, res, next) {
    try { res.json({ success: true, data: await service[method](req.auth.userId) }); }
    catch (error) { next(error); }
  };
}
module.exports = createDashboardController;
