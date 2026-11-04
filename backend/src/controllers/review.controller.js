function createReviewController(service) {
  return {
    async record(req, res, next) {
      try {
        const data = await service.record(req.auth.userId, req.body);
        return res.status(200).json({ success: true, data });
      } catch (error) { next(error); }
    },
  };
}
module.exports = createReviewController;
