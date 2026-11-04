const isPostgresUnavailable = require('../config/postgres-errors');
const { ReviewsUnavailableError } = require('../services/review.service');

function factor(value) {
  if (typeof value !== 'string' || !/^\d{1,4}(\.\d{1,4})?$/.test(value)) {
    throw new Error('Estado NUMERIC inválido');
  }
  const number = Number(value);
  if (number < 1.3 || number > 9999.9999 || Math.round(number * 10000) / 10000 !== number) {
    throw new Error('Estado NUMERIC fuera de rango');
  }
  return number;
}
function date(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('Fecha persistida inválida');
  return value;
}
function result(row) {
  return row && {
    reviewId: row.id, flashcardId: row.flashcard_id, quality: row.quality,
    easeFactor: factor(row.ease_factor_after), intervalDays: row.interval_after_days,
    reviewedAt: date(row.reviewed_at).toISOString(), nextReviewAt: date(row.next_review_at).toISOString(),
  };
}

function createReviewRepository(pool, { clock } = {}) {
  const find = async (client, userId, requestId) => result((await client.query(`
    SELECT id, flashcard_id, quality, ease_factor_after, interval_after_days, reviewed_at, next_review_at
    FROM public.card_reviews WHERE user_id = $1 AND request_id = $2`, [userId, requestId])).rows[0]);

  return {
    async findDue(userId, limit) {
      // statement_timestamp es estable durante la sentencia y procede de PostgreSQL.
      const { rows } = await pool.query(`
        SELECT f.id AS flashcard_id, f.lesson_id, l.title AS lesson_title,
          c.slug AS course_slug, f.front, f.back, p.flashcard_id AS progress_id,
          p.repetitions, p.ease_factor, p.interval_days, p.last_review_at, p.next_review_at
        FROM public.flashcards f
        JOIN public.lessons l ON l.id = f.lesson_id
        JOIN public.units u ON u.id = l.unit_id
        JOIN public.courses c ON c.id = u.course_id
        LEFT JOIN public.user_card_progress p ON p.flashcard_id = f.id AND p.user_id = $1
        LEFT JOIN public.user_lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $1
        WHERE (p.flashcard_id IS NULL AND lp.completed_at IS NOT NULL)
           OR p.next_review_at <= COALESCE($3::timestamptz, statement_timestamp())
        ORDER BY p.next_review_at ASC NULLS LAST, c.slug, u.position, l.position, f.position, f.id
        LIMIT $2`, [userId, limit, clock ? date(await clock()) : null]);
      return rows.map(row => ({ ...row,
        ease_factor: row.progress_id === null ? null : factor(row.ease_factor),
        last_review_at: row.last_review_at === null ? null : date(row.last_review_at).toISOString(),
        next_review_at: row.next_review_at === null ? null : date(row.next_review_at).toISOString(),
      }));
    },
    async findHistory(userId, limit, offset) {
      // Total y página comparten instantánea; LEFT JOIN conserva total fuera de página.
      const { rows } = await pool.query(`
        SELECT totals.total, page.*
        FROM (SELECT count(*) AS total FROM public.card_reviews WHERE user_id = $1) totals
        LEFT JOIN LATERAL (
          SELECT r.id, r.flashcard_id, c.slug AS course_slug, l.title AS lesson_title,
            f.front, r.quality, r.reviewed_at, r.ease_factor_before, r.ease_factor_after,
            r.interval_before_days, r.interval_after_days, r.next_review_at
          FROM public.card_reviews r
          JOIN public.flashcards f ON f.id = r.flashcard_id
          JOIN public.lessons l ON l.id = f.lesson_id
          JOIN public.units u ON u.id = l.unit_id
          JOIN public.courses c ON c.id = u.course_id
          WHERE r.user_id = $1
          ORDER BY r.reviewed_at DESC, r.id DESC
          LIMIT $2 OFFSET $3
        ) page ON true
        ORDER BY page.reviewed_at DESC, page.id DESC`, [userId, limit, offset]);
      const total = Number(rows[0].total);
      if (!Number.isSafeInteger(total) || total < 0) throw new Error('Total inválido');
      return { total, items: rows.filter(row => row.id !== null).map(row => {
        if (typeof row.id !== 'string' || !/^[1-9][0-9]*$/.test(row.id)) throw new Error('BIGSERIAL inválido');
        return { ...row, ease_factor_before: factor(row.ease_factor_before),
          ease_factor_after: factor(row.ease_factor_after),
          reviewed_at: date(row.reviewed_at).toISOString(), next_review_at: date(row.next_review_at).toISOString() };
      }) };
    },
    async record(userId, input, work, recover) {
      let client;
      let releaseError;
      let committing = false;
      let uniqueConflict;
      try {
        client = await pool.connect();
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        const pair = [userId, input.flashcardId];
        const tx = {
          findReview: () => find(client, userId, input.requestId),
          // FOR UPDATE solo no protege el primer estado (todavía no existe fila).
          lockCard: () => client.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', pair),
          async findCard() {
            return (await client.query(`SELECT f.id, (p.completed_at IS NOT NULL) AS completed
              FROM public.flashcards f JOIN public.lessons l ON l.id = f.lesson_id
              LEFT JOIN public.user_lesson_progress p ON p.lesson_id = l.id AND p.user_id = $1
              WHERE f.id = $2`, pair)).rows[0];
          },
          async findProgress() {
            const row = (await client.query(`SELECT repetitions, ease_factor, interval_days, next_review_at
              FROM public.user_card_progress WHERE user_id = $1 AND flashcard_id = $2 FOR UPDATE`, pair)).rows[0];
            return row && { repetitions: row.repetitions, easeFactor: factor(row.ease_factor),
              intervalDays: row.interval_days, nextReviewAt: date(row.next_review_at) };
          },
          async now() {
            return date(clock ? await clock() : (await client.query('SELECT clock_timestamp() AS now')).rows[0].now);
          },
          async saveProgress(next) {
            await client.query(`INSERT INTO public.user_card_progress AS p
              (user_id, flashcard_id, repetitions, ease_factor, interval_days, last_review_at, next_review_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7)
              ON CONFLICT (user_id, flashcard_id) DO UPDATE SET
                repetitions = EXCLUDED.repetitions, ease_factor = EXCLUDED.ease_factor,
                interval_days = EXCLUDED.interval_days, last_review_at = EXCLUDED.last_review_at,
                next_review_at = EXCLUDED.next_review_at, updated_at = GREATEST(p.updated_at, clock_timestamp())`,
            [...pair, next.repetitions, next.easeFactor, next.intervalDays, next.lastReviewAt, next.nextReviewAt]);
          },
          async insertReview(previous, next) {
            return result((await client.query(`INSERT INTO public.card_reviews
              (user_id, flashcard_id, request_id, quality, reviewed_at, ease_factor_before,
               ease_factor_after, interval_before_days, interval_after_days, next_review_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
              RETURNING id, flashcard_id, quality, ease_factor_after, interval_after_days, reviewed_at, next_review_at`,
            [...pair, input.requestId, input.quality, next.lastReviewAt, previous.easeFactor,
              next.easeFactor, previous.intervalDays, next.intervalDays, next.nextReviewAt])).rows[0]);
          },
        };
        const response = await work(tx);
        committing = true;
        await client.query('COMMIT');
        return response;
      } catch (error) {
        if (client) {
          if (committing || isPostgresUnavailable(error)) releaseError = error;
          try { await client.query('ROLLBACK'); } catch (rollbackError) { releaseError = rollbackError; }
        }
        // Solo esta restricción representa una colisión idempotente entre tarjetas.
        if (!releaseError && error.code === '23505' && error.constraint === 'card_reviews_user_id_request_id_key') {
          uniqueConflict = error;
        } else {
          if (isPostgresUnavailable(error)) throw new ReviewsUnavailableError();
          throw error;
        }
      } finally {
        if (client) client.release(releaseError);
      }
      // Fuera de la transacción abortada, con cliente nuevo; nunca recuperar escrituras parciales.
      const reader = await pool.connect().catch((error) => {
        if (isPostgresUnavailable(error)) throw new ReviewsUnavailableError();
        throw error;
      });
      let readError;
      try {
        const original = await find(reader, userId, input.requestId);
        if (!original) throw uniqueConflict;
        return recover(original);
      } catch (error) {
        if (isPostgresUnavailable(error)) { readError = error; throw new ReviewsUnavailableError(); }
        throw error;
      } finally { reader.release(readError); }
    },
  };
}
module.exports = createReviewRepository;
