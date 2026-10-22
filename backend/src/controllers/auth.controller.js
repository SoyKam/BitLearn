const { InvalidSessionError } = require('../services/auth.service');

function readRefreshCookie(req) {
  const header = req.get('cookie');
  if (typeof header !== 'string' || header.length > 8192) return null;
  let token = null;
  let found = false;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) return null;
    if (part.slice(0, separator).trim() !== 'bitlearn_refresh') continue;
    if (found) return null;
    found = true;
    try { token = decodeURIComponent(part.slice(separator + 1).trim()); } catch { return null; }
  }
  return token;
}

function createAuthController(authService, { cookieSecure = true } = {}) {
  const cookieOptions = (req) => ({
    httpOnly: true, sameSite: 'strict', secure: cookieSecure || req.secure, path: '/api/auth',
  });
  function setRefreshCookie(req, res, result) {
    res.cookie('bitlearn_refresh', result.refreshToken, {
      ...cookieOptions(req),
      // Descontar el tiempo de la transacción; nunca superar la expiración persistida.
      maxAge: Math.max(0, Math.floor((result.refreshExpiresAt.getTime() - Date.now()) / 1000) * 1000),
    });
  }
  const clearRefreshCookie = (req, res) => res.clearCookie('bitlearn_refresh', cookieOptions(req));
  return {
    async refresh(req, res, next) {
      try {
        const result = await authService.refresh(readRefreshCookie(req));
        setRefreshCookie(req, res, result);
        res.status(200).json({ success: true, data: {
          accessToken: result.accessToken, expiresIn: result.expiresIn,
        } });
      } catch (error) {
        if (error instanceof InvalidSessionError) clearRefreshCookie(req, res);
        next(error);
      }
    },
    async logout(req, res, next) {
      try {
        await authService.logout(readRefreshCookie(req));
        clearRefreshCookie(req, res);
        res.status(200).json({ success: true, message: 'Sesión cerrada correctamente.' });
      } catch (error) {
        clearRefreshCookie(req, res);
        next(error);
      }
    },
    async me(req, res, next) {
      try {
        res.status(200).json({ success: true, data: await authService.me(req.auth) });
      } catch (error) {
        next(error);
      }
    },
    async login(req, res, next) {
      try {
        const result = await authService.login(req.body);
        setRefreshCookie(req, res, result);
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
