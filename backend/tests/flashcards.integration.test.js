const assert=require('node:assert/strict');
const {test}=require('node:test');
const {once}=require('node:events');
const express=require('express');
const {Pool}=require('pg');
const {temporaryPostgres,postgresSkip}=require('./helpers/temporary-postgres');
const migrate=require('../src/config/migrate');
const {seedCatalog}=require('../src/config/seed-catalog');
const {seedQuestions}=require('../src/config/seed-questions');
const {seedFlashcards}=require('../src/config/seed-flashcards');
const cards=require('../database/seeds/003_web_flashcards.json');
const repository=require('../src/repositories/flashcard.repository');
const {createFlashcardService}=require('../src/services/flashcard.service');
const router=require('../src/routes/flashcard.routes');
const errorHandler=require('../src/middlewares/error-handler');

test('flashcards: PostgreSQL temporal, concurrencia, rollback y consulta sin escrituras', {skip:postgresSkip,timeout:60000},async t=>{
  const {connection,database}=await temporaryPostgres(t); const pool=await database(t);
  await migrate(pool,{log(){}});
  await pool.query('ALTER SEQUENCE courses_id_seq RESTART WITH 40; ALTER SEQUENCE units_id_seq RESTART WITH 60; ALTER SEQUENCE lessons_id_seq RESTART WITH 80');
  await seedCatalog(pool); await seedQuestions(pool);
  const snapshot=async()=>{
    const result={};
    for(const table of ['courses','units','lessons','questions','flashcards','users','user_lesson_progress','user_card_progress','card_reviews']) result[table]=(await pool.query(`SELECT * FROM public.${table} ORDER BY 1`)).rows;
    return result;
  };
  const before=await snapshot();
  const second=new Pool({...connection,database:pool.options.database}); t.after(()=>second.end());
  const concurrent=await Promise.all([seedFlashcards(pool),seedFlashcards(second)]);
  assert.deepEqual(concurrent.map(r=>r.filter(c=>c.created).length).sort((a,b)=>a-b),[0,15]);
  const loaded=await snapshot(); assert.equal(loaded.flashcards.length,15); assert.deepEqual({...loaded,flashcards:[]},before);
  assert.equal((await seedFlashcards(pool)).filter(c=>c.created).length,0); assert.deepEqual(await snapshot(),loaded);
  const rows=(await pool.query(`SELECT c.slug,u.position AS unit_position,u.title AS unit_title,l.position AS lesson_position,l.title AS lesson_title,f.position,f.front,f.back FROM flashcards f JOIN lessons l ON l.id=f.lesson_id JOIN units u ON u.id=l.unit_id JOIN courses c ON c.id=u.course_id ORDER BY c.id,u.position,l.position,f.position`)).rows;
  assert.deepEqual(rows,cards.map(c=>({slug:c.courseSlug,unit_position:c.unitPosition,unit_title:c.unitTitle,lesson_position:c.lessonPosition,lesson_title:c.lessonTitle,position:c.position,front:c.front,back:c.back})));
  for(const mutation of ["back = 'Conflicto'",'position = 9']) {
    await pool.query('DELETE FROM flashcards'); const last=loaded.flashcards.at(-1);
    await pool.query('INSERT INTO flashcards(lesson_id,position,front,back) VALUES ($1,$2,$3,$4)',[last.lesson_id,last.position,last.front,last.back]);
    await pool.query(`UPDATE flashcards SET ${mutation}`); const conflicted=await snapshot();
    await assert.rejects(seedFlashcards(pool),/Conflicto/); assert.deepEqual(await snapshot(),conflicted);
  }
  await pool.query('DELETE FROM flashcards');
  await pool.query("UPDATE lessons SET title='Renombrada' WHERE id=(SELECT max(id) FROM lessons)"); const renamed=await snapshot();
  await assert.rejects(seedFlashcards(pool),/identidad/); assert.deepEqual(await snapshot(),renamed);
  await pool.query('UPDATE lessons SET title=$1 WHERE id=(SELECT max(id) FROM lessons)',[cards.at(-1).lessonTitle]); await seedFlashcards(pool);
  await pool.query("INSERT INTO courses(title,slug) VALUES ('Vacío','empty')");
  const courseId=(await pool.query("SELECT id FROM courses WHERE slug='html'")).rows[0].id;
  const unitId=(await pool.query("INSERT INTO units(course_id,title,position) VALUES ($1,'Extra',2) RETURNING id",[courseId])).rows[0].id;
  const lessonId=(await pool.query("INSERT INTO lessons(unit_id,title,position) VALUES ($1,'Extra',1) RETURNING id",[unitId])).rows[0].id;
  await pool.query("INSERT INTO flashcards(lesson_id,position,front,back) VALUES ($1,2,'Segunda','B'),($1,1,'Primera','A')",[lessonId]);
  const extra=await snapshot(); await seedFlashcards(pool); assert.deepEqual(await snapshot(),extra);
  // Un GET que intentase escribir fallaría incluso con el rol de pruebas.
  await pool.query('SET default_transaction_read_only = on');
  const app=express(); app.use('/api/flashcards',router(createFlashcardService(repository(pool)))); app.use(errorHandler);
  const server=app.listen(0,'127.0.0.1'); t.after(()=>new Promise(resolve=>server.close(resolve))); await once(server,'listening');
  const url=`http://127.0.0.1:${server.address().port}/api/flashcards?course=`;
  for(const slug of ['html','css','javascript']) {
    const response=await fetch(url+slug); assert.equal(response.status,200); const result=(await response.json()).data;
    assert.deepEqual(result.map(c=>c.front),[...cards.filter(c=>c.courseSlug===slug).map(c=>c.front),...(slug==='html'?['Primera','Segunda']:[])]);
    for(const c of result) assert.deepEqual(Object.keys(c),['id','lessonId','lessonTitle','position','front','back']);
  }
  assert.deepEqual(await (await fetch(url+'empty')).json(),{success:true,data:[]}); assert.equal((await fetch(url+'missing')).status,404);
  assert.deepEqual(await snapshot(),extra); assert.deepEqual(extra.user_card_progress,[]); assert.deepEqual(extra.card_reviews,[]);
});
