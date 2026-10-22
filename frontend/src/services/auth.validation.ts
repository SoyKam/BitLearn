import type { FieldErrors, LoginInput, RegisterForm } from '../types/auth'

export function validateLogin(input: LoginInput): FieldErrors {
  const errors: FieldErrors = {}
  const email = input.email.trim()
  if (!email) errors.email = 'Introduce tu correo electrónico.'
  else if (email.length > 150 || !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u.test(email)) errors.email = 'Introduce un correo válido de hasta 150 caracteres.'
  if (!input.password) errors.password = 'Introduce tu contraseña.'
  else if (input.password.includes('\u0000') || new TextEncoder().encode(input.password).length > 72) errors.password = 'La contraseña admite hasta 72 bytes UTF-8 y no permite caracteres nulos.'
  return errors
}

export function validateRegister(input: RegisterForm): FieldErrors {
  const errors = validateLogin(input)
  const name = input.name.trim()
  if (!name) errors.name = 'Introduce tu nombre.'
  else if (name.length > 100 || /[\u0000-\u001f\u007f]/u.test(name)) errors.name = 'El nombre admite hasta 100 caracteres y no permite caracteres de control.'
  if (!errors.password && (input.password.length < 12 || !input.password.trim())) errors.password = 'Utiliza al menos 12 caracteres; la contraseña no puede contener solo espacios.'
  if (!input.confirmation) errors.confirmation = 'Confirma tu contraseña.'
  else if (input.confirmation !== input.password) errors.confirmation = 'Las contraseñas no coinciden.'
  return errors
}
