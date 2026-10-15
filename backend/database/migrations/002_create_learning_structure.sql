-- El migrador controla la transacción y evita aplicar de nuevo una versión registrada.
CREATE TABLE public.courses (
  id SERIAL PRIMARY KEY,
  title VARCHAR(150) NOT NULL CHECK (title ~ '[^[:space:]]'),
  slug VARCHAR(150) UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description TEXT
);

CREATE TABLE public.units (
  id SERIAL PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES public.courses(id) ON DELETE RESTRICT,
  title VARCHAR(150) NOT NULL CHECK (title ~ '[^[:space:]]'),
  position INTEGER NOT NULL CHECK (position > 0),
  UNIQUE (course_id, position)
);

CREATE TABLE public.lessons (
  id SERIAL PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES public.units(id) ON DELETE RESTRICT,
  title VARCHAR(150) NOT NULL CHECK (title ~ '[^[:space:]]'),
  position INTEGER NOT NULL CHECK (position > 0),
  -- Permite definir la estructura antes de incorporar el contenido de la lección.
  content TEXT,
  UNIQUE (unit_id, position)
);

-- Los índices únicos (course_id, position) y (unit_id, position) cubren las
-- búsquedas por clave foránea y el orden dentro del padre, sin índices redundantes.
