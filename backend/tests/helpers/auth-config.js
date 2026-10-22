const { randomBytes } = require('node:crypto');
const loadAuthConfig = require('../../src/config/auth');

function testEnvironment(overrides = {}) {
  return { AUTH_JWT_SECRET_HEX: randomBytes(32).toString('hex'),
    AUTH_JWT_ISSUER: 'bitlearn-test', AUTH_JWT_AUDIENCE: 'bitlearn-test-web',
    NODE_ENV: 'test', AUTH_ALLOW_INSECURE_COOKIE: 'false', ...overrides };
}

module.exports = { testEnvironment, testConfig: () => loadAuthConfig(testEnvironment()) };
