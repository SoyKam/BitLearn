const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const http = require('node:http');
const express = require('express');
const { createDashboardService } = require('../src/services/dashboard.service');
const repository = require('../src/repositories/dashboard.repository');
const router = require('../src/routes/dashboard.routes');
const errorHandler = require('../src/middlewares/error-handler');
const { InvalidSessionError } = require('../src/services/auth.service');
const spec = require('../src/config/swagger');
const row = (overrides = {}) => ({ total_lessons: '9', completed_lessons: '4',
  studied_flashcards: '5', due_reviews: '3', total_reviews: '12',
  course_id: 1, course_slug: 'html', course_title: 'HTML',
  course_total_lessons: '3', course_completed_lessons: '2', ...overrides });
const service = rows => createDashboardService({ async findByUser(id) { assert.equal(id, 7); return rows; } });

test('normaliza contadores y porcentajes generales y por curso', async () => {
  const result = await service([row()]).get(7);
  assert.deepEqual(result, { summary: { totalLessons: 9, completedLessons: 4, completionPercent: 44.44,
    studiedFlashcards: 5, dueReviews: 3, totalReviews: 12 }, courses: [{ courseId: 1, courseSlug: 'html',
    courseTitle: 'HTML', totalLessons: 3, completedLessons: 2, completionPercent: 66.67 }] });
});
test('usuario nuevo, curso vacío, parcial y completo sin mezclar cursos; conserva orden SQL', async () => {
  const courses = [row({ course_id: 4, course_slug: 'empty', course_total_lessons: '0', course_completed_lessons: '0' }),
    row(), row({ course_id: 2, course_slug: 'javascript', course_completed_lessons: '3' })];
  assert.deepEqual((await service(courses).get(7)).courses.map(c => c.completionPercent), [0,66.67,100]);
  assert.deepEqual((await service(courses).get(7)).courses.map(c => c.courseSlug), ['empty','html','javascript']);
  const fresh = row({ completed_lessons:'0', studied_flashcards:'0', due_reviews:'0', total_reviews:'0', course_completed_lessons:'0' });
  assert.equal((await service([fresh]).get(7)).summary.completionPercent, 0);
  assert.equal((await service([fresh]).get(7)).courses[0].completionPercent, 0);
  const empty = await service([row({ ...fresh, total_lessons:'0', course_id:null })]).get(7);
  assert.deepEqual(empty, { summary:{totalLessons:0,completedLessons:0,completionPercent:0,studiedFlashcards:0,dueReviews:0,totalReviews:0},courses:[] });
});
test('rechaza todos los contadores inválidos sin truncar ni producir NaN/Infinity', async () => {
  for (const field of ['total_lessons','completed_lessons','studied_flashcards','due_reviews','total_reviews','course_total_lessons','course_completed_lessons','course_id']) {
    for (const value of [-1,1.5,NaN,Infinity,'9007199254740992','9007199254740993','1.1','1e2','',null,undefined,true,' 1']) {
      if (field === 'course_id' && value === null) continue;
      await assert.rejects(service([row({ [field]: value })]).get(7), undefined, `${field}: ${value}`);
    }
  }
  await assert.rejects(service([row({ completed_lessons:'10' })]).get(7));
  await assert.rejects(service([row({ course_total_lessons:'0' })]).get(7));
  assert.equal((await service([row({ total_lessons:'9007199254740991', completed_lessons:'9007199254740991' })]).get(7)).summary.completionPercent,100);
});
test('repositorio: una sentencia SELECT parametrizada, sin límites ni escrituras', async () => {
  let calls = 0;
  const db = { async query(sql, params) {
    calls++; assert.deepEqual(params, ["7' OR true"]);
    assert.doesNotMatch(sql, /7'|\b(INSERT|UPDATE|DELETE|LIMIT|OFFSET)\b/i);
    assert.match(sql, /statement_timestamp\(\)/); assert.match(sql, /ORDER BY c.course_slug, c.course_id/);
    assert.match(sql, /user_id = \$1/); return { rows:[row()] };
  } };
  assert.deepEqual(await repository(db).findByUser("7' OR true"),[row()]); assert.equal(calls,1);
});
async function serve(t, get, authenticate = async () => ({userId:7})) {
  const app = express(); app.use('/api/dashboard',router({get}, {authenticate})); app.use(errorHandler);
  const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return (path = '', {token='a.b.c', body, headers={}} = {}) => new Promise((resolve,reject) => {
    const req = http.request({ hostname:'127.0.0.1',port:server.address().port,path:'/api/dashboard'+path,method:'GET',
      headers:{...(token ? {Authorization:`Bearer ${token}`} : {}),...(body ? {'Content-Length':Buffer.byteLength(body)} : {}),...headers}}, res => {
      let text=''; res.on('data',chunk => {text+=chunk;}); res.on('end',() => {
        assert.equal(res.headers['cache-control'],'no-store'); assert.ok(res.headers['x-correlation-id']);
        resolve({status:res.statusCode,body:JSON.parse(text)});
      });
    }); req.on('error',reject); req.end(body);
  });
}
test('HTTP: identidad exclusiva de sesión, rechaza query desconocida/repetida y cualquier cuerpo', async t => {
  let calls=0;
  const request = await serve(t, async id => { calls++; assert.equal(id,7); return {summary:{},courses:[]}; });
  assert.equal((await request('',{headers:{'userId':'999','x-user-id':'999'}})).status,200);
  for (const query of ['?userId=8','?foo=1','?foo=1&foo=2','?userId=7&userId=8','?limit=50','?%75serId=8']) {
    assert.equal((await request(query)).status,400);
  }
  for (const body of ['{"userId":8}','{}','not json']) assert.equal((await request('',{body})).status,400);
  assert.equal(calls,1);
});
test('HTTP: sin JWT, inválido y sesión revocada no consultan estadísticas', async t => {
  const request = await serve(t, () => assert.fail('No consultar'), async () => {throw new InvalidSessionError();});
  for (const token of ['', 'invalid', 'a.b.c']) assert.equal((await request('',{token})).status,401);
});
test('errores 500/503 seguros también durante autenticación', async t => {
  t.mock.method(console,'error',() => {});
  for (const code of ['ECONNREFUSED','57P01','XX000']) {
    const fail = async () => { throw Object.assign(new Error('SELECT password FROM secret host=private'),{code}); };
    for (const auth of [false,true]) {
      const request = await serve(t,fail,auth ? fail : undefined);
      const response=await request(); assert.equal(response.status,code==='XX000' ? 500:503);
      assert.doesNotMatch(JSON.stringify(response.body),/SELECT|password|private|stack|host/);
    }
  }
});
test('Swagger conserva endpoints y documenta contrato, seguridad y errores', () => {
  const get=spec.paths['/api/dashboard'].get;
  assert.deepEqual(get.security,[{bearerAuth:[]}]);
  assert.deepEqual(Object.keys(get.responses),['200','400','401','500','503']);
  for (const name of ['DashboardSummary','DashboardCourse','DashboardData']) assert.ok(spec.components.schemas[name]);
  for (const path of ['/api/auth/login','/api/courses','/api/progress','/api/reviews/due','/api/reviews/history']) assert.ok(spec.paths[path]);
});
