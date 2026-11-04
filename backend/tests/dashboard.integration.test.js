const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { temporaryPostgres, postgresSkip } = require('./helpers/temporary-postgres');
const serve = require('./helpers/course-app');
const migrate = require('../src/config/migrate');
const { seedCatalog } = require('../src/config/seed-catalog');
const { seedQuestions } = require('../src/config/seed-questions');
const { seedFlashcards } = require('../src/config/seed-flashcards');
const { createDashboardService } = require('../src/services/dashboard.service');
const repository = require('../src/repositories/dashboard.repository');

test('dashboard HTTP con PostgreSQL temporal aislado', {skip:postgresSkip,timeout:60000}, async t => {
  const {database}=await temporaryPostgres(t); const pool=await database(t);
  await migrate(pool,{log(){}}); await seedCatalog(pool); await seedQuestions(pool); await seedFlashcards(pool);
  const base=await serve(t,pool);
  async function request(path,token,body) {
    const res=await fetch(base+path,{method:body ? 'POST':'GET',headers:{...(token ? {Authorization:`Bearer ${token}`} : {}),
      ...(body ? {'Content-Type':'application/json'} : {})},...(body ? {body:JSON.stringify(body)} : {})});
    if (path.startsWith('/api/dashboard')) {
      assert.equal(res.headers.get('cache-control'),'no-store'); assert.ok(res.headers.get('x-correlation-id'));
    }
    return {status:res.status,body:await res.json()};
  }
  const users=[];
  for (const name of ['Alice','Bob']) {
    const credentials={name,email:`${name}@example.invalid`,password:'Ficticio-password-123'};
    const registered=await request('/api/auth/register',null,credentials); assert.equal(registered.status,201);
    const login=await request('/api/auth/login',null,{email:credentials.email,password:credentials.password});
    assert.equal(login.status,200); users.push({id:registered.body.data.id,token:login.body.data.accessToken});
  }
  const [alice,bob]=users;
  const questions=(await pool.query(`SELECT q.*,c.slug FROM questions q JOIN lessons l ON l.id=q.lesson_id
    JOIN units u ON u.id=l.unit_id JOIN courses c ON c.id=u.course_id ORDER BY c.slug,l.position`)).rows;
  const q=questions[0]; const other=questions.find(x=>x.slug!==q.slug);
  const cards=(await pool.query('SELECT * FROM flashcards WHERE lesson_id=$1 ORDER BY position',[q.lesson_id])).rows;
  async function snapshot() {
    const state={};
    for (const table of ['courses','units','lessons','questions','flashcards','users','auth_sessions',
      'auth_refresh_tokens','user_lesson_progress','user_card_progress','card_reviews']) {
      state[table]=(await pool.query(`SELECT * FROM public.${table} ORDER BY 1,2`)).rows;
    }
    return state;
  }
  async function get(user=alice) {
    const before=await snapshot();
    // max:1: autenticación y dashboard comparten conexión de solo lectura.
    await pool.query('SET default_transaction_read_only = on');
    try {
      const result=await request('/api/dashboard',user.token); assert.equal(result.status,200,JSON.stringify(result));
      assert.deepEqual(await snapshot(),before);
      assert.doesNotMatch(JSON.stringify(result.body),/user_id|password|token|session|request_id/);
      return result.body.data;
    } finally { await pool.query('SET default_transaction_read_only = off'); }
  }
  async function answer(question,user=alice,correct=true) {
    const result=await request(`/api/lessons/${question.lesson_id}/answer`,user.token,{questionId:question.id,
      optionIndex:correct ? question.correct_option_index : (question.correct_option_index+1)%question.options.length});
    assert.equal(result.status,200);
  }
  await t.test('sin actividad o con intentos fallidos: ceros sin estados',async()=>{
    const data=await get();
    assert.deepEqual(data.summary,{totalLessons:questions.length,completedLessons:0,completionPercent:0,studiedFlashcards:0,dueReviews:0,totalReviews:0});
    assert.deepEqual(data.courses.map(c=>c.courseSlug),['css','html','javascript']);
    assert.ok(data.courses.every(c=>c.completedLessons===0 && c.completionPercent===0));
    await answer(q,alice,false); assert.deepEqual(await get(),data);
  });
  await t.test('completar y repetir respuestas, dos cursos y aislamiento',async()=>{
    await answer(q); await answer(q);
    let data=await get(); assert.equal(data.summary.completedLessons,1);
    assert.equal(data.summary.dueReviews,cards.length); assert.equal(data.summary.studiedFlashcards,0);
    assert.equal(data.courses.find(c=>c.courseSlug===q.slug).completionPercent,33.33);
    await answer(other); data=await get();
    assert.equal(data.summary.completedLessons,2); assert.equal(data.summary.completionPercent,22.22);
    assert.equal(data.courses.find(c=>c.courseSlug===other.slug).completedLessons,1);
    assert.equal((await get(bob)).summary.completedLessons,0);
    assert.equal(data.summary.dueReviews,(await request('/api/reviews/due',alice.token)).body.data.length);
  });
  await t.test('POST real y replay; múltiples repasos cuentan una tarjeta y dos registros',async()=>{
    const before=await get(); const payload={flashcardId:cards[0].id,quality:5,requestId:randomUUID()};
    assert.equal((await request('/api/reviews',alice.token,payload)).status,200);
    let data=await get(); assert.equal(data.summary.studiedFlashcards,1); assert.equal(data.summary.totalReviews,1);
    assert.equal(data.summary.dueReviews,before.summary.dueReviews-1);
    assert.equal((await request('/api/reviews',alice.token,payload)).body.data.replayed,true);
    assert.deepEqual(await get(),data);
    await pool.query("UPDATE user_card_progress SET next_review_at='2000-01-01' WHERE user_id=$1",[alice.id]);
    assert.equal((await get()).summary.dueReviews,before.summary.dueReviews);
    assert.equal((await request('/api/reviews',alice.token,{...payload,requestId:randomUUID()})).status,200);
    data=await get(); assert.equal(data.summary.studiedFlashcards,1); assert.equal(data.summary.totalReviews,2);
    assert.equal(data.summary.totalReviews,(await request('/api/reviews/history',alice.token)).body.data.total);
    await answer(q,bob);
    assert.equal((await request('/api/reviews',bob.token,{...payload,requestId:randomUUID()})).status,200);
    assert.equal((await get(bob)).summary.totalReviews,1); assert.deepEqual(await get(),data);
  });
  await t.test('estado vencido sin finalización y futuro excluido',async()=>{
    await pool.query('UPDATE user_lesson_progress SET completed_at=NULL WHERE user_id=$1 AND lesson_id=$2',[alice.id,q.lesson_id]);
    const data=await get();
    assert.equal(data.summary.dueReviews,(await request('/api/reviews/due',alice.token)).body.data.length);
    await pool.query("UPDATE user_card_progress SET next_review_at='2000-01-01' WHERE user_id=$1",[alice.id]);
    assert.equal((await get()).summary.dueReviews,data.summary.dueReviews+1);
    await answer(q);
  });
  await t.test('curso completo, curso sin lecciones y pendientes superiores a 100',async()=>{
    for (const question of questions.filter(x=>x.slug===q.slug)) await answer(question);
    await pool.query("INSERT INTO courses(title,slug) VALUES ('Vacío','empty')");
    await pool.query(`INSERT INTO flashcards(lesson_id,position,front,back)
      SELECT $1,n,'Extra '||n,'Respuesta' FROM generate_series(10,120) n`,[q.lesson_id]);
    const data=await get(); assert.equal(data.courses.find(c=>c.courseSlug===q.slug).completionPercent,100);
    const empty=data.courses.find(c=>c.courseSlug==='empty');
    assert.deepEqual(empty,{courseId:empty.courseId,courseSlug:'empty',courseTitle:'Vacío',totalLessons:0,completedLessons:0,completionPercent:0});
    const expected=(await pool.query(`SELECT count(*)::int AS total FROM flashcards f
      WHERE EXISTS(SELECT 1 FROM user_lesson_progress p WHERE p.user_id=$1 AND p.lesson_id=f.lesson_id AND completed_at IS NOT NULL)`,[alice.id])).rows[0].total;
    assert.equal(data.summary.dueReviews,expected); assert.ok(expected>100);
    assert.equal((await request('/api/reviews/due',alice.token)).body.data.length,50);
    assert.equal((await request('/api/reviews/due?limit=100',alice.token)).body.data.length,100);
  });
  await t.test('identidad ajena, JWT ausente/inválido y sesión revocada',async()=>{
    for (const suffix of [`?userId=${bob.id}`,'?foo=1','?foo=1&foo=2']) assert.equal((await request('/api/dashboard'+suffix,alice.token)).status,400);
    const claims=jwt.decode(bob.token);
    await pool.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[claims.sid]);
    for (const token of [null,'invalid','a.b.c',bob.token]) assert.equal((await request('/api/dashboard',token)).status,401);
  });
  await t.test('catálogo vacío y curso vacío: ceros sin divisiones ni escrituras',async()=>{
    const empty=await database(t); await migrate(empty,{log(){}});
    const service=createDashboardService(repository(empty));
    await empty.query('SET default_transaction_read_only = on');
    const expected={summary:{totalLessons:0,completedLessons:0,completionPercent:0,studiedFlashcards:0,dueReviews:0,totalReviews:0},courses:[]};
    assert.deepEqual(await service.get(alice.id),expected);
    await empty.query('SET default_transaction_read_only = off');
    const course=(await empty.query("INSERT INTO courses(title,slug) VALUES ('Vacío','empty') RETURNING id")).rows[0];
    await empty.query('SET default_transaction_read_only = on');
    assert.deepEqual(await service.get(alice.id),{...expected,courses:[{courseId:course.id,courseSlug:'empty',courseTitle:'Vacío',totalLessons:0,completedLessons:0,completionPercent:0}]});
  });
});
