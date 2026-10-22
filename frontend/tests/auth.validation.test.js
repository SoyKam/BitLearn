import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/services/auth.validation.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
})
const { validateLogin, validateRegister } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
const valid = { name: 'Juan Pérez', email: 'juan@example.com', password: 'MiClaveSegura2026!', confirmation: 'MiClaveSegura2026!' }

test('registro válido y límites exactos de longitud', () => {
  assert.deepEqual(validateRegister(valid), {})
  assert.deepEqual(validateRegister({ ...valid, name: 'a'.repeat(100), password: 'a'.repeat(72), confirmation: 'a'.repeat(72) }), {})
})

test('registro incompleto identifica los cuatro campos', () => {
  assert.deepEqual(Object.keys(validateRegister({ name: '', email: '', password: '', confirmation: '' })).sort(), ['confirmation', 'email', 'name', 'password'])
})

for (const email of ['incorrecto', 'a@@example.com', 'a@b', 'a b@example.com', `${'a'.repeat(140)}@example.com`]) {
  test(`correo inválido: ${email.length > 50 ? 'más de 150 caracteres' : email}`, () => {
    assert.ok(validateRegister({ ...valid, email }).email)
  })
}

for (const [label, password] of [['corta', 'abc'], ['solo espacios', ' '.repeat(12)], ['nulo', 'abcdef\u0000ghijklmnop'], ['73 bytes ASCII', 'a'.repeat(73)], ['UTF-8 multibyte', '🔐'.repeat(19)]]) {
  test(`contraseña inválida: ${label}`, () => {
    assert.ok(validateRegister({ ...valid, password, confirmation: password }).password)
  })
}

test('72 bytes UTF-8 válidos; contraseña no se recorta ni normaliza', () => {
  const password = '🔐'.repeat(18)
  const input = { ...valid, password, confirmation: password }
  assert.deepEqual(validateRegister(input), {})
  const spaced = { ...valid, password: '  clave valida  ', confirmation: '  clave valida  ' }
  assert.deepEqual(validateRegister(spaced), {})
  assert.equal(spaced.password, '  clave valida  ')
})

test('confirmación idéntica, nombre máximo y caracteres de control', () => {
  assert.ok(validateRegister({ ...valid, confirmation: `${valid.password} ` }).confirmation)
  assert.ok(validateRegister({ ...valid, name: 'a'.repeat(101) }).name)
  assert.ok(validateRegister({ ...valid, name: 'Juan\nPérez' }).name)
})

test('login permite claves heredadas cortas sin relajar máximo de bytes', () => {
  assert.deepEqual(validateLogin({ email: valid.email, password: 'legacy' }), {})
  assert.ok(validateLogin({ email: valid.email, password: 'é'.repeat(37) }).password)
  assert.ok(validateLogin({ email: valid.email, password: '' }).password)
})
