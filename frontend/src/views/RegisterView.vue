<script setup lang="ts">
import { nextTick, reactive, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import AuthField from '../components/AuthField.vue'
import { validateRegister } from '../services/auth.validation'
import { useAuthStore } from '../stores/auth.store'
import type { FieldErrors, RegisterForm } from '../types/auth'

const auth = useAuthStore()
const router = useRouter()
const form = reactive<RegisterForm>({ name: '', email: '', password: '', confirmation: '' })
const errors = ref<FieldErrors>({})
const submitting = ref(false)

async function submit(event: Event) {
  if (submitting.value || auth.loading) return
  errors.value = validateRegister(form)
  auth.error = null
  if (Object.keys(errors.value).length) {
    const element = event.currentTarget
    await nextTick()
    if (element instanceof HTMLFormElement) element.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus()
    return
  }
  submitting.value = true
  try {
    if (await auth.register({ name: form.name, email: form.email, password: form.password })) {
      form.password = ''; form.confirmation = ''
      await router.replace({ name: 'login' })
    }
  } finally { submitting.value = false }
}
</script>

<template>
  <main class="auth-page" aria-labelledby="register-title">
    <RouterLink class="brand auth-brand" to="/"><span class="brand-mark" aria-hidden="true">&lt;/&gt;</span>BitLearn</RouterLink>
    <h1 id="register-title">Crea tu cuenta</h1>
    <p class="auth-intro">Da el primer paso para aprender a tu ritmo.</p>
    <form novalidate :aria-busy="submitting" @submit.prevent="submit">
      <fieldset :disabled="submitting || auth.loading">
        <legend class="sr-only">Datos de registro</legend>
        <AuthField id="name" v-model="form.name" label="Nombre" autocomplete="name" :maxlength="100" :error="errors.name" />
        <AuthField id="email" v-model="form.email" label="Correo electrónico" type="email" autocomplete="email" :maxlength="150" :error="errors.email" />
        <AuthField id="password" v-model="form.password" label="Contraseña" type="password" autocomplete="new-password" :error="errors.password" hint="Al menos 12 caracteres y hasta 72 bytes UTF-8. Algunos caracteres ocupan varios bytes." />
        <AuthField id="confirmation" v-model="form.confirmation" label="Confirmar contraseña" type="password" autocomplete="new-password" :error="errors.confirmation" />
        <p v-if="Object.keys(errors).length" role="alert" class="field-error">Revisa los campos indicados.</p>
        <p v-if="auth.error" role="alert" class="feedback error">{{ auth.error.message }}</p>
        <button class="button primary" type="submit" :disabled="submitting || auth.loading">{{ submitting ? 'Creando cuenta…' : 'Crear cuenta' }}</button>
      </fieldset>
      <p class="sr-only" role="status">{{ submitting ? 'Enviando registro.' : '' }}</p>
    </form>
    <nav class="auth-links" aria-label="Navegación de registro">
      <RouterLink to="/iniciar-sesion">Ya tengo una cuenta</RouterLink>
      <RouterLink to="/">Regresar al inicio</RouterLink>
    </nav>
  </main>
</template>
