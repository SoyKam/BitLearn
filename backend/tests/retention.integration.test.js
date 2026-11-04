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


test('retención HTTP aislada, solo lectura y contratos', {skip:postgresSkip,timeout:60000}, async t => {
  const {database}=await temporaryPostgres(t); const pool=await database(t);
  await migrate(pool,{log(){}}); await seedCatalog(pool); await seedFlashcards(pool);
  const base=await serve(t,pool);
  async function request(path,token,body) {
    const res=await fetch(base+path,{method:body?'POST':'GET',headers:{...(token?{Authorization:`Bearer ${token}`}:{}),
      ...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    if(path.startsWith('/api/dashboard')) { assert.equal(res.headers.get('cache-control'),'no-store'); assert.ok(res.headers.get('x-correlation-id')); }
    return {status:res.status,body:await res.json()};
  }
  const users=[];
  for(const name of ['Alice','Bob']) {
    const credentials={name,email:`${name}@example.invalid`,password:'Ficticio-password-123'};
    const registered=await request('/api/auth/register',null,credentials);
    const login=await request('/api/auth/login',null,{email:credentials.email,password:credentials.password});
    users.push({id:registered.body.data.id,token:login.body.data.accessToken});
  }
  const [a,b]=users, path='/api/dashboard/retention';
  let data=(await request(path,a.token)).body.data;
  assert.equal(data.modeledCards,0); assert.equal(data.averageRetentionNowPercent,null);
  assert.equal(data.nextScheduledReviewAt,null); assert.deepEqual(data.points,[]); assert.ok(Number.isFinite(Date.parse(data.asOf)));
  const cards=(await pool.query('SELECT id FROM flashcards ORDER BY id')).rows;
  async function insert(user,index,interval,last,next) {
    await pool.query('INSERT INTO user_card_progress(user_id,flashcard_id,interval_days,last_review_at,next_review_at) VALUES($1,$2,$3,$4,$5)',
      [user.id,cards[index].id,interval,last,next]);
  }
  await insert(a,0,6,'2026-01-01','2026-01-07');
  data=(await request(path,a.token)).body.data; assert.equal(data.modeledCards,1);
  await insert(a,1,15,'2026-01-01','2099-01-01');
  await insert(a,2,0,null,'2098-01-01');
  await insert(b,0,1,'2026-01-01','2026-01-02');
  const snapshot=async()=>Promise.all(['user_card_progress','card_reviews'].map(async table=>(await pool.query(`SELECT * FROM ${table} ORDER BY 1,2`)).rows));
  const before=await snapshot();
  await pool.query('SET default_transaction_read_only = on');
  data=(await request(path,a.token)).body.data;
  assert.equal(data.modeledCards,2); assert.equal(data.nextScheduledReviewAt,'2099-01-01T00:00:00.000Z');
  const elapsed=Math.max(0,(Date.parse(data.asOf)-Date.parse('2026-01-01'))/86400000);
  for(const point of data.points) {
    const expected=(Math.exp(-(elapsed+point.daysAhead)*Math.LN2/6)+Math.exp(-(elapsed+point.daysAhead)*Math.LN2/15))/2;
    assert.equal(point.estimatedRetentionPercent,Math.round(expected*10000)/100);
  }
  assert.equal(data.averageRetentionNowPercent,data.points[0].estimatedRetentionPercent);
  assert.equal((await request(path,b.token)).body.data.modeledCards,1);
  assert.equal((await request('/api/dashboard',a.token)).body.data.summary.studiedFlashcards,3);
  for(const suffix of ['/due','/history']) assert.equal((await request('/api/reviews'+suffix,a.token)).status,200);
  assert.deepEqual(await snapshot(),before);
  await pool.query('SET default_transaction_read_only = off');
  for(const query of ['?userId=2','?asOf=2026-01-01','?x=1&x=2']) assert.equal((await request(path+query,a.token)).status,400);
  assert.equal((await request(path)).status,401);
  await pool.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[jwt.decode(b.token).sid]);
  assert.equal((await request(path,b.token)).status,401);
});
