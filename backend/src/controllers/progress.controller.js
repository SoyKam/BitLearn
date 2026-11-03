function createProgressController(service) {
  return async function get(req, res, next) {
    try { res.json({ success: true, data: await service.get(req.auth.userId) }); }
    catch (error) { next(error); }
  };
}
module.exports = createProgressController;
