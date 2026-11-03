-- La transacción y el bloqueo advisory pertenecen al migrador.
CREATE TABLE public.questions (
  id SERIAL PRIMARY KEY,
  lesson_id INTEGER NOT NULL REFERENCES public.lessons(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position > 0),
  prompt TEXT NOT NULL CHECK (prompt ~ '[^[:space:]]'),
  options JSONB NOT NULL,
  correct_option_index INTEGER NOT NULL,
  explanation TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK (isfinite(created_at)),
  UNIQUE (lesson_id, position),
  -- CASE evita evaluar jsonb_array_length sobre objetos o escalares.
  CHECK (CASE WHEN jsonb_typeof(options) = 'array' THEN
    jsonb_array_length(options) BETWEEN 2 AND 6
    AND correct_option_index >= 0 AND correct_option_index < jsonb_array_length(options)
    ELSE FALSE END)
);

CREATE TABLE public.user_lesson_progress (
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  lesson_id INTEGER NOT NULL REFERENCES public.lessons(id) ON DELETE RESTRICT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  correct_answers INTEGER NOT NULL DEFAULT 0 CHECK (correct_answers >= 0 AND correct_answers <= attempts),
  completed_at TIMESTAMPTZ CHECK (isfinite(completed_at)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK (isfinite(created_at)),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK (isfinite(updated_at) AND updated_at >= created_at),
  PRIMARY KEY (user_id, lesson_id)
);

CREATE TABLE public.flashcards (
  id SERIAL PRIMARY KEY,
  lesson_id INTEGER NOT NULL REFERENCES public.lessons(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position > 0),
  front TEXT NOT NULL CHECK (front ~ '[^[:space:]]'),
  back TEXT NOT NULL CHECK (back ~ '[^[:space:]]'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK (isfinite(created_at)),
  UNIQUE (lesson_id, position)
);

CREATE TABLE public.user_card_progress (
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  flashcard_id INTEGER NOT NULL REFERENCES public.flashcards(id) ON DELETE RESTRICT,
  repetitions INTEGER NOT NULL DEFAULT 0 CHECK (repetitions >= 0),
  ease_factor NUMERIC(8,4) NOT NULL DEFAULT 2.5000 CHECK (ease_factor >= 1.3000 AND ease_factor <> 'NaN'::numeric),
  interval_days INTEGER NOT NULL DEFAULT 0 CHECK (interval_days >= 0),
  last_review_at TIMESTAMPTZ CHECK (isfinite(last_review_at)),
  next_review_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK (isfinite(next_review_at)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK (isfinite(created_at)),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK (isfinite(updated_at) AND updated_at >= created_at),
  PRIMARY KEY (user_id, flashcard_id)
);
CREATE INDEX user_card_progress_due_idx ON public.user_card_progress (user_id, next_review_at);

CREATE TABLE public.card_reviews (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  flashcard_id INTEGER NOT NULL,
  request_id UUID NOT NULL,
  quality SMALLINT NOT NULL CHECK (quality BETWEEN 0 AND 5),
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK (isfinite(reviewed_at)),
  ease_factor_before NUMERIC(8,4) NOT NULL CHECK (ease_factor_before >= 1.3000 AND ease_factor_before <> 'NaN'::numeric),
  ease_factor_after NUMERIC(8,4) NOT NULL CHECK (ease_factor_after >= 1.3000 AND ease_factor_after <> 'NaN'::numeric),
  interval_before_days INTEGER NOT NULL CHECK (interval_before_days >= 0),
  interval_after_days INTEGER NOT NULL CHECK (interval_after_days >= 0),
  next_review_at TIMESTAMPTZ NOT NULL CHECK (isfinite(next_review_at)),
  FOREIGN KEY (user_id, flashcard_id) REFERENCES public.user_card_progress(user_id, flashcard_id) ON DELETE RESTRICT,
  UNIQUE (user_id, request_id)
);
CREATE INDEX card_reviews_history_idx ON public.card_reviews (user_id, reviewed_at DESC);
