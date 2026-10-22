function createAuthController(authService, { cookieSecure = true } = {}) {
  return {
    async login(req, res, next) {
      try {
        const result = await authService.login(req.body);
        res.cookie('bitlearn_refresh', result.refreshToken, {
          httpOnly: true,
          sameSite: 'strict',
          secure: cookieSecure || req.secure,
          path: '/api/auth',
          // Descontar el tiempo de la transacción; la cookie nunca vive más que la fila.
          maxAge: Math.max(0, Math.floor((result.refreshExpiresAt.getTime() - Date.now()) / 1000) * 1000),
        });
        res.status(200).json({ success: true, data: {
          user: result.user, accessToken: result.accessToken, expiresIn: result.expiresIn,
        } });
      } catch (error) {
        next(error);
      }
    },
    async register(req, res, next) {
      try {
        const user = await authService.register(req.body);
        res.status(201).json({ success: true, data: user });
      } catch (error) {
        next(error);
      }
    },
  };
}

module.exports = createAuthController;
