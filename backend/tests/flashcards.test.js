const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const { once } = require('node:events');
const cards = require('../database/seeds/003_web_flashcards.json');
const { validateFlashcards, seedFlashcards, FlashcardSeedError } = require('../src/config/seed-flashcards');
const repository = require('../src/repositories/flashcard.repository');
const { createFlashcardService } = require('../src/services/flashcard.service');
const router = require('../src/routes/flashcard.routes');
const errorHandler = require('../src/middlewares/error-handler');

test('seed: contenido complementario y distribución 2–2–1 por curso', () => {
  assert.deepEqual(validateFlashcards(cards), cards);
  const questions = require('../database/seeds/002_web_questions.json');
  for (const slug of ['html','css','javascript']) {
    const selected = cards.filter(c => c.courseSlug === slug);
    assert.equal(selected.length, 5);
    assert.deepEqual([1,2,3].map(n => selected.filter(c => c.lessonPosition === n).length), [2,2,1]);
  }
  for (const c of cards) assert.ok(!questions.some(q => q.prompt === c.front));
  assert.match(cards[8].back, /no margin/);
  assert.match(cards[10].back, /modificar sus propiedades/);
  assert.match(cards[13].back, /sin convertirlos/);
});
test('seed: entradas inválidas y duplicados se rechazan antes de conectar', async () => {
  const variants = [cards.slice(1), [...cards,cards[0]]];
  for (const [key,value] of [['courseSlug','HTML'],['unitPosition',0],['lessonPosition',1.5],['position',-1],['front',' \n'],['back',''],['unitTitle','Otra'],['lessonTitle','Selectores CSS'],['extra',true]]) {
    const data = structuredClone(cards); data[0][key] = value; variants.push(data);
  }
  for (const key of ['position','front']) {
    const data = structuredClone(cards); data[1][key] = data[0][key]; variants.push(data);
  }
  const duplicate = structuredClone(cards); duplicate[1] = duplicate[0]; variants.push(duplicate);
  const imbalance = structuredClone(cards); imbalance[4] = {...cards[14],position:2}; variants.push(imbalance);
  for (const data of variants) await assert.rejects(seedFlashcards({ connect() { assert.fail('No conectar'); } },data), FlashcardSeedError);
});
test('seed: rollback fallido descarta cliente y no filtra errores', async () => {
  const calls = []; let released;
  const client = { async query(sql) { calls.push(sql); if (sql !== 'BEGIN') throw Error('password secreto'); }, release(value) { released=value; } };
  await assert.rejects(seedFlashcards({async connect() {return client;} }), /descartó/);
  assert.equal(calls.at(-1),'ROLLBACK'); assert.equal(released,true);
});
test('API pública: contrato, SQL parametrizado, validación, escritura bloqueada y errores seguros', async t => {
  t.mock.method(console,'error',()=>{});
  const calls=[]; let failure;
  const db={async query(sql,params) {
    calls.push({sql,params}); assert.match(sql.trim(),/^SELECT/); assert.match(sql,/WHERE c.slug = \$1/);
    assert.doesNotMatch(sql,/user_card_progress|card_reviews|users/);
    if(failure) throw failure;
    if(params[0]==='missing') return {rows:[]};
    if(params[0]==='empty') return {rows:[{id:null}]};
    return {rows:[{id:7,lesson_id:21,lesson_title:params[0],position:1,front:'Pregunta',back:'Respuesta',userId:99,easeFactor:2.5}]};
  }};
  const app=express(); app.use('/api/flashcards',router(createFlashcardService(repository(db)))); app.use(errorHandler);
  const server=app.listen(0,'127.0.0.1'); t.after(()=>new Promise(resolve=>server.close(resolve))); await once(server,'listening');
  const url=`http://127.0.0.1:${server.address().port}/api/flashcards`;
  for(const slug of ['html','css','javascript','curso-2']) {
    const response=await fetch(url+'?course='+slug); assert.equal(response.status,200); assert.ok(response.headers.get('x-correlation-id'));
    assert.deepEqual(await response.json(),{success:true,data:[{id:7,lessonId:21,lessonTitle:slug,position:1,front:'Pregunta',back:'Respuesta'}]});
    assert.deepEqual(calls.at(-1).params,[slug]);
  }
  const before=calls.length;
  for(const query of ['', '?course=', '?course=HTML','?course=html&course=css','?course[]=html','?course[x]=html','?course=html&extra=1','?course=-html','?course=html-','?course=a--b','?course=html%0A','?course=ht%20ml','?course=html%27%3BDROP%20TABLE%20users',`?course=${'a'.repeat(151)}`]) assert.equal((await fetch(url+query)).status,400,query);
  for(const method of ['POST','PUT','PATCH','DELETE']) assert.equal((await fetch(url+'?course=html',{method})).status,404);
  assert.equal(calls.length,before);
  assert.equal((await fetch(url+'?course=missing')).status,404);
  assert.deepEqual(await (await fetch(url+'?course=empty')).json(),{success:true,data:[]});
  for(const [code,status] of [['ECONNREFUSED',503],['XX000',500]]) {
    failure=Object.assign(Error('SQL password secreto'),{code}); const response=await fetch(url+'?course=html');
    assert.equal(response.status,status); assert.doesNotMatch(JSON.stringify(await response.json()),/SQL|password|secreto/);
  }
});
test('Swagger: acceso público y respuestas documentadas',()=>{
  const spec=require('../src/config/swagger'); const endpoint=spec.paths['/api/flashcards'].get;
  assert.deepEqual(endpoint.security,[]); assert.deepEqual(Object.keys(endpoint.responses),['200','400','404','500','503']);
  assert.deepEqual(spec.components.schemas.Flashcard.required,['id','lessonId','lessonTitle','position','front','back']);
});
