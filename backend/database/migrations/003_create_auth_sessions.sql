-- El migrador controla la transacción. Cada sesión pertenece a un solo usuario.
CREATE TABLE public.auth_sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK (isfinite(created_at)),
  expires_at TIMESTAMPTZ NOT NULL CHECK (isfinite(expires_at) AND expires_at > created_at),
  -- También se puede revocar una sesión que ya haya expirado.
  revoked_at TIMESTAMPTZ CHECK (isfinite(revoked_at) AND revoked_at >= created_at)
);

CREATE INDEX auth_sessions_user_id_idx ON public.auth_sessions (user_id);

CREATE TABLE public.auth_refresh_tokens (
  -- SHA-256 en hexadecimal minúsculo de un token aleatorio de alta entropía.
  -- La aplicación futura debe calcular el hash; nunca guardar el token original.
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  session_id INTEGER NOT NULL REFERENCES public.auth_sessions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK (isfinite(created_at)),
  expires_at TIMESTAMPTZ NOT NULL CHECK (isfinite(expires_at) AND expires_at > created_at),
  -- Conserva el hash consumido al rotar para reconocer intentos de reutilización.
  used_at TIMESTAMPTZ CHECK (isfinite(used_at) AND used_at >= created_at AND used_at < expires_at)
);

-- Incluye el historial completo de cada sesión.
CREATE INDEX auth_refresh_tokens_session_id_idx ON public.auth_refresh_tokens (session_id);

-- Rotar requerirá marcar el anterior como usado e insertar el nuevo en una transacción.
CREATE UNIQUE INDEX auth_refresh_tokens_one_unused_per_session_idx
  ON public.auth_refresh_tokens (session_id) WHERE used_at IS NULL;
