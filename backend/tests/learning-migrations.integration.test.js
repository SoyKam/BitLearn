const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const migrate = require('../src/config/migrate');
const { temporaryPostgres, postgresSkip } = require('./helpers/temporary-postgres');
const tables = ['questions','user_lesson_progress','flashcards','user_card_progress','card_reviews'];
const silent = { log() {} };
test('004: esquema, integridad y concurrencia aislados', { skip: postgresSkip, timeout: 60000 }, async (t) => {
  const { temporary, connection, database } = await temporaryPostgres(t);
  const pool = await database(t);
  const directory = fs.mkdtempSync(path.join(temporary, 'sql-'));
  const source = path.join(__dirname, '../database/migrations');
  for (const name of fs.readdirSync(source).filter((n) => /^00[123]_/.test(n))) fs.copyFileSync(path.join(source,name),path.join(directory,name));
  await migrate(pool, { ...silent, directory });
  await pool.query(`INSERT INTO users(name,email,password) VALUES ('A','a@example.invalid','fixture'),('B','b@example.invalid','fixture');
    INSERT INTO courses(title,slug) VALUES ('HTML','html');
    INSERT INTO units(course_id,title,position) VALUES (1,'Unidad',1);
    INSERT INTO lessons(unit_id,title,position) VALUES (1,'Lección',1);
    INSERT INTO auth_sessions(user_id,expires_at) VALUES (1,CURRENT_TIMESTAMP + INTERVAL '1 day');
    INSERT INTO auth_refresh_tokens(token_hash,session_id,expires_at) VALUES (repeat('a',64),1,CURRENT_TIMESTAMP + INTERVAL '1 day')`);
  async function snapshot() {
    const result = {};
    for (const table of ['users','courses','units','lessons','auth_sessions','auth_refresh_tokens']) result[table] = (await pool.query(`SELECT * FROM ${table}`)).rows;
    return result;
  }
  const before = await snapshot();
  const name = '004_create_learning_progress.sql';
  fs.writeFileSync(path.join(directory,name), fs.readFileSync(path.join(source,name),'utf8') + '\nSELECT 1/0;');
  await assert.rejects(migrate(pool,{ ...silent,directory }), /004_create_learning_progress/);
  for (const table of tables) assert.equal((await pool.query('SELECT to_regclass($1) AS name',[table])).rows[0].name,null);
  assert.deepEqual(await snapshot(),before);
  const second = new Pool({ ...connection, database: pool.options.database });
  t.after(() => second.end());
  await Promise.all([migrate(pool,silent),migrate(second,silent)]);
  assert.deepEqual(await snapshot(),before);
  const registry = (await pool.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
  assert.deepEqual(registry.map((r) => r.version),['1','2','3','4']);
  await migrate(pool,silent);
  assert.deepEqual((await pool.query('SELECT * FROM schema_migrations ORDER BY version')).rows,registry);
  for (const [i,table] of tables.entries()) {
    assert.deepEqual((await pool.query(`SELECT * FROM ${table}`)).rows,[]);
    const constraints = (await pool.query('SELECT contype,confdeltype,pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid=$1::regclass',[table])).rows;
    assert.ok(constraints.some((c) => c.def === `PRIMARY KEY (${['id','user_id, lesson_id','id','user_id, flashcard_id','id'][i]})`));
    assert.equal(constraints.filter((c) => c.contype === 'f' && c.confdeltype === 'r').length,[1,2,1,2,1][i]);
    assert.equal(constraints.filter((c) => c.contype === 'u').length,[1,0,1,0,1][i]);
    const columns = (await pool.query("SELECT column_name,data_type,numeric_precision,numeric_scale FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",[table])).rows;
    for (const c of columns) {
      if (c.column_name.endsWith('_at')) assert.equal(c.data_type,'timestamp with time zone');
      if (c.column_name.startsWith('ease_factor')) { assert.equal(c.numeric_precision,8); assert.equal(c.numeric_scale,4); }
      if (c.column_name === 'options') assert.equal(c.data_type,'jsonb');
      if (c.column_name === 'request_id') assert.equal(c.data_type,'uuid');
      if (c.column_name === 'quality') assert.equal(c.data_type,'smallint');
      if (c.column_name === 'id') assert.equal(c.data_type,table === 'card_reviews' ? 'bigint' : 'integer');
      if (['user_id','lesson_id','flashcard_id','position','attempts','correct_answers','repetitions','interval_days','correct_option_index','interval_before_days','interval_after_days'].includes(c.column_name)) assert.equal(c.data_type,'integer');
    }
  }
  const indexes = (await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname='public'")).rows.map((r) => r.indexdef);
  assert.ok(indexes.some((s) => s.endsWith('(user_id, next_review_at)')));
  assert.ok(indexes.some((s) => s.endsWith('(user_id, reviewed_at DESC)')));
  await pool.query(`INSERT INTO questions(lesson_id,position,prompt,options,correct_option_index) VALUES (1,1,'Pregunta','["A","B"]',0);
    INSERT INTO flashcards(lesson_id,position,front,back) VALUES (1,1,'Frente','Respuesta');
    INSERT INTO user_lesson_progress(user_id,lesson_id) VALUES (1,1);
    INSERT INTO user_card_progress(user_id,flashcard_id) VALUES (1,1)`);
  const state = (await pool.query('SELECT * FROM user_card_progress')).rows[0];
  assert.equal(state.ease_factor,'2.5000'); assert.equal(state.repetitions,0); assert.equal(state.interval_days,0); assert.equal(state.last_review_at,null);
  assert.deepEqual(state.next_review_at,state.created_at); assert.deepEqual(state.updated_at,state.created_at);
  const lesson = (await pool.query('SELECT * FROM user_lesson_progress')).rows[0];
  assert.equal(lesson.attempts,0); assert.equal(lesson.correct_answers,0); assert.equal(lesson.completed_at,null);
  await assert.rejects(pool.query('INSERT INTO user_lesson_progress(user_id,lesson_id) VALUES (1,1)'),{ code:'23505' });
  await assert.rejects(pool.query(`INSERT INTO questions(lesson_id,position,prompt,options,correct_option_index) VALUES (1,1,'Otra','["A","B"]',1)`),{ code:'23505' });
  await assert.rejects(pool.query(`INSERT INTO flashcards(lesson_id,position,front,back) VALUES (1,1,'Otra','Respuesta')`),{ code:'23505' });
  for (const [table, columns] of [['questions',['prompt','options','correct_option_index']],['flashcards',['front','back']],['user_card_progress',['ease_factor','next_review_at']]]) {
    for (const column of columns) await assert.rejects(pool.query(`UPDATE ${table} SET ${column}=NULL`),{ code:'23502' });
  }
  const review = `INSERT INTO card_reviews(user_id,flashcard_id,request_id,quality,ease_factor_before,ease_factor_after,interval_before_days,interval_after_days,next_review_at) VALUES (1,1,'00000000-0000-4000-8000-000000000001',5,2.5,2.6,0,1,CURRENT_TIMESTAMP)`;
  await pool.query(review);
  for (const [table, mutations] of [
    ['questions',["position=0","position=-1","prompt=''","prompt=E' \\t\\n'","options='{}'","options='null'","options='[]'","options='[1]'","options='[1,2,3,4,5,6,7]'",'correct_option_index=-1','correct_option_index=2']],
    ['flashcards',['position=0','position=-1',"front=''","back=' '"]],
    ['user_lesson_progress',['attempts=-1','correct_answers=-1','correct_answers=1',"updated_at='2000-01-01'"]],
    ['user_card_progress',['repetitions=-1','interval_days=-1','ease_factor=1.2',"ease_factor='NaN'"]],
    ['card_reviews',['quality=-1','quality=6','ease_factor_before=1.2','ease_factor_after=1.2',"ease_factor_after='NaN'",'interval_before_days=-1','interval_after_days=-1']],
  ]) {
    for (const mutation of mutations) await assert.rejects(pool.query(`UPDATE ${table} SET ${mutation}`),{ code:'23514' });
    const dates = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name=$1 AND column_name LIKE '%_at'",[table])).rows;
    for (const c of dates) await assert.rejects(pool.query(`UPDATE ${table} SET ${c.column_name}='infinity'`),{ code:'23514' });
  }
  for (const [table,cols] of [['questions',['lesson_id']],['flashcards',['lesson_id']],['user_lesson_progress',['user_id','lesson_id']],['user_card_progress',['user_id','flashcard_id']],['card_reviews',['user_id','flashcard_id']]]) {
    for (const col of cols) await assert.rejects(pool.query(`UPDATE ${table} SET ${col}=-1`),{ code:'23503' });
  }
  for (const table of ['users','lessons','flashcards','user_card_progress']) await assert.rejects(pool.query(`DELETE FROM ${table}`),{ code:'23503' });
  await assert.rejects(pool.query(review),{ code:'23505' });
  for (const statement of ['INSERT INTO user_card_progress(user_id,flashcard_id) VALUES (2,1)',review.replace('VALUES (1,1,','VALUES (2,1,')]) {
    const results = await Promise.allSettled([pool.query(statement),second.query(statement)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length,1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code,'23505');
  }
  await pool.query('UPDATE user_card_progress SET repetitions=3 WHERE user_id=1');
  assert.equal((await pool.query('SELECT repetitions FROM user_card_progress WHERE user_id=2')).rows[0].repetitions,0);
});
