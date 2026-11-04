function createReviewController(service) {
  return {
    async due(req, res, next) {
      try {
        const data = await service.due(req.auth.userId, req.reviewQuery);
        return res.status(200).json({ success: true, data });
      } catch (error) { next(error); }
    },
    async history(req, res, next) {
      try {
        const data = await service.history(req.auth.userId, req.reviewQuery);
        return res.status(200).json({ success: true, data });
      } catch (error) { next(error); }
    },
    async record(req, res, next) {
      try {
        const data = await service.record(req.auth.userId, req.body);
        return res.status(200).json({ success: true, data });
      } catch (error) { next(error); }
    },
  };
}
module.exports = createReviewController;
