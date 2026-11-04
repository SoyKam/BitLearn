const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculateRetention: r, projectRetention: project } = require('../src/domain/retention');
for (const interval of [0, 1, 6, 15, 2147483647]) test('modelo intervalo '+interval, () => {
  assert.equal(r(interval,0),1);
  assert.ok(Math.abs(r(interval,Math.max(1,interval))-.5)<1e-14);
  assert.ok(Math.abs(r(interval,2*Math.max(1,interval))-.25)<1e-14);
  assert.ok(r(interval,Number.MAX_VALUE)>=0);
});
for (const bad of [-1, .5, NaN, Infinity, 2147483648, '6', null]) test('intervalo inválido '+bad,()=>assert.throws(()=>r(bad,1)));
for (const bad of [-1, NaN, Infinity, '1', null]) test('tiempo inválido '+bad,()=>assert.throws(()=>r(6,bad)));
test('UTC, cruces de mes/año, promedio, determinismo, no mutaciones y horizontes',()=>{
  for (const [last,now] of [['2026-01-31','2026-02-01'],['2026-12-31','2027-01-01']]) {
    const states=Object.freeze([Object.freeze({intervalDays:1,lastReviewAt:new Date(last)}),
      Object.freeze({intervalDays:2,lastReviewAt:new Date(last)}),Object.freeze({lastReviewAt:null})]);
    const before=structuredClone(states); const asOf=new Date(now);
    const result=project(states,asOf);
    assert.deepEqual(project(states,asOf),result); assert.deepEqual(states,before);
    assert.equal(result.modeledCards,2);
    assert.ok(Math.abs(result.points[0].retention-(.5+Math.sqrt(.5))/2)<1e-14);
    assert.deepEqual(result.points.map(p=>p.daysAhead),[0,1,3,7,14,30]);
    result.points.forEach((p,i)=>{assert.ok(p.retention>=0&&p.retention<=1);if(i)assert.ok(p.retention<=result.points[i-1].retention);});
  }
});
test('sin estados, sin repaso, reloj futuro e instantes inválidos',()=>{
  const now=new Date('2026-11-04T00:00:00Z');
  assert.deepEqual(project([],now),{modeledCards:0,points:[]});
  assert.deepEqual(project([{lastReviewAt:null}],now),{modeledCards:0,points:[]});
  assert.equal(project([{intervalDays:6,lastReviewAt:new Date(now.getTime()+1000)}],now).points[0].retention,1);
  assert.throws(()=>project([],new Date(NaN)));
  assert.throws(()=>project([{intervalDays:1,lastReviewAt:new Date(NaN)}],now));
  assert.throws(()=>project([],now,[-1]));
});
const { once } = require('node:events');
const http = require('node:http');
const express = require('express');
const { createDashboardService } = require('../src/services/dashboard.service');
const repository = require('../src/repositories/dashboard.repository');
const router = require('../src/routes/dashboard.routes');
const errorHandler = require('../src/middlewares/error-handler');
const { InvalidSessionError } = require('../src/services/auth.service');
const spec = require('../src/config/swagger');
async function serve(t, get, authenticate = async () => ({userId:7})) {
  const app = express(); app.use('/api/dashboard',router({getRetention:get}, {authenticate})); app.use(errorHandler);
  const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return (path = '', {token='a.b.c', body, headers={}} = {}) => new Promise((resolve,reject) => {
    const req = http.request({ hostname:'127.0.0.1',port:server.address().port,path:'/api/dashboard/retention'+path,method:'GET',
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
test('Swagger describe retención estimada, vacío y errores',()=>{
  const endpoint=spec.paths['/api/dashboard/retention'].get;
  assert.deepEqual(endpoint.security,[{bearerAuth:[]}]);
  assert.deepEqual(Object.keys(endpoint.responses),['200','400','401','500','503']);
  assert.match(endpoint.description,/no validado ni calibrado/);
  assert.match(endpoint.responses['200'].description,/modeledCards 0/);
});
