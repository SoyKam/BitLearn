const { InvalidSessionError } = require('../services/auth.service');

function createAuthenticate(authService) {
  return async function authenticate(req, res, next) {
    try {
      const header = req.get('authorization');
      const count = req.rawHeaders.filter((value, index) => index % 2 === 0
        && value.toLowerCase() === 'authorization').length;
      const match = typeof header === 'string' && header.length <= 4096
        && /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header);
      if (count !== 1 || !match) throw new InvalidSessionError();
      req.auth = Object.freeze(await authService.authenticate(match[1]));
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = createAuthenticate;
