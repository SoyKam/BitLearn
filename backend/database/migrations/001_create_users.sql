-- Adopta la tabla del ejemplo del profesor sin alterar sus columnas ni sus datos.
CREATE TABLE IF NOT EXISTS public.users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DO $$
DECLARE
  expected RECORD;
  actual RECORD;
  id_number SMALLINT;
  email_number SMALLINT;
  id_sequence TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid = 'public.users'::regclass AND relkind = 'r'
  ) THEN
    RAISE EXCEPTION 'users debe ser una tabla ordinaria' USING ERRCODE = 'BL001';
  END IF;

  -- Evita cambios concurrentes de estructura durante la comprobación inicial.
  LOCK TABLE public.users IN SHARE ROW EXCLUSIVE MODE;

  FOR expected IN
    SELECT * FROM (VALUES
      ('id', 'integer', TRUE),
      ('name', 'character varying(100)', TRUE),
      ('email', 'character varying(150)', TRUE),
      ('password', 'character varying(255)', TRUE),
      ('created_at', 'timestamp without time zone', FALSE)
    ) AS columns(name, type, required)
  LOOP
    SELECT a.attnum, format_type(a.atttypid, a.atttypmod) AS type,
           a.attnotnull, a.attidentity, a.attgenerated,
           pg_get_expr(d.adbin, d.adrelid) AS default_value
    INTO actual
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = 'public.users'::regclass AND a.attname = expected.name
      AND a.attnum > 0 AND NOT a.attisdropped;

    IF NOT FOUND OR actual.type <> expected.type
       OR (expected.required AND NOT actual.attnotnull)
       OR actual.attgenerated <> '' THEN
      RAISE EXCEPTION 'Columna users.% incompatible', expected.name USING ERRCODE = 'BL001';
    END IF;

    IF expected.name = 'id' THEN
      id_number := actual.attnum;
      id_sequence := pg_get_serial_sequence('public.users', 'id');
      IF id_sequence IS NULL OR (
        actual.attidentity = '' AND actual.default_value IS DISTINCT FROM
          format('nextval(%L::regclass)', id_sequence::regclass::text)
      ) THEN
        RAISE EXCEPTION 'users.id debe ser autoincremental' USING ERRCODE = 'BL001';
      END IF;
    ELSIF expected.name = 'email' THEN
      email_number := actual.attnum;
    ELSIF expected.name = 'created_at' THEN
      IF actual.default_value IS NULL OR actual.default_value NOT IN
         ('CURRENT_TIMESTAMP', 'now()', 'transaction_timestamp()') THEN
        RAISE EXCEPTION 'users.created_at requiere fecha actual predeterminada' USING ERRCODE = 'BL001';
      END IF;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.users'::regclass
      AND contype = 'p' AND conkey = ARRAY[id_number]
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_index WHERE indrelid = 'public.users'::regclass
      AND indisunique AND indisvalid AND indisready AND indnkeyatts = 1
      AND indkey[0] = email_number AND indpred IS NULL AND indexprs IS NULL
  ) THEN
    RAISE EXCEPTION 'users requiere PK en id y unicidad en email' USING ERRCODE = 'BL001';
  END IF;

  -- Las columnas adicionales son compatibles si permiten las inserciones del modelo actual.
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.users'::regclass AND attnum > 0 AND NOT attisdropped
      AND attname NOT IN ('id', 'name', 'email', 'password', 'created_at')
      AND attnotnull AND NOT atthasdef AND attidentity = ''
  ) THEN
    RAISE EXCEPTION 'users contiene columnas adicionales obligatorias sin valor predeterminado'
      USING ERRCODE = 'BL001';
  END IF;
END;
$$;
