<script setup lang="ts">
import { nextTick, reactive, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import AuthField from '../components/AuthField.vue'
import { loginDestination } from '../router/auth.guard'
import { validateLogin } from '../services/auth.validation'
import { useAuthStore } from '../stores/auth.store'
import type { FieldErrors, LoginInput } from '../types/auth'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()
const form = reactive<LoginInput>({ email: '', password: '' })
const errors = ref<FieldErrors>({})
const submitting = ref(false)

async function submit(event: Event) {
  if (submitting.value || auth.loading) return
  errors.value = validateLogin(form)
  auth.error = null
  if (Object.keys(errors.value).length) {
    const element = event.currentTarget
    await nextTick()
    if (element instanceof HTMLFormElement) element.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus()
    return
  }
  submitting.value = true
  try {
    if (await auth.login({ email: form.email, password: form.password })) {
      form.password = ''
      await router.replace(loginDestination(route.query.redirect))
    }
  } finally { submitting.value = false }
}

async function retrySession() {
  if (await auth.restoreSession(true)) await router.replace(loginDestination(route.query.redirect))
}
</script>

<template>
  <main class="auth-page" aria-labelledby="login-title">
    <RouterLink class="brand auth-brand" to="/"><span class="brand-mark" aria-hidden="true">&lt;/&gt;</span>BitLearn</RouterLink>
    <h1 id="login-title">Inicia sesión</h1>
    <p class="auth-intro">Qué bueno verte de nuevo.</p>
    <div v-if="auth.status === 'unavailable'" class="feedback" role="status">
      <p>No pudimos comprobar tu sesión. Puedes reintentar cuando se recupere la conexión.</p>
      <button class="button" type="button" :disabled="auth.loading" @click="retrySession">Reintentar sesión</button>
    </div>
    <form novalidate :aria-busy="submitting" @submit.prevent="submit">
      <fieldset :disabled="submitting || auth.loading">
        <legend class="sr-only">Credenciales de acceso</legend>
        <AuthField id="email" v-model="form.email" label="Correo electrónico" type="email" autocomplete="email" :maxlength="150" :error="errors.email" />
        <AuthField id="password" v-model="form.password" label="Contraseña" type="password" autocomplete="current-password" :error="errors.password" />
        <p v-if="Object.keys(errors).length" role="alert" class="field-error">Revisa los campos indicados.</p>
        <p v-if="auth.error" role="alert" class="feedback error">{{ auth.error.message }}</p>
        <button class="button primary" type="submit" :disabled="submitting || auth.loading">{{ submitting ? 'Iniciando sesión…' : 'Iniciar sesión' }}</button>
      </fieldset>
      <p class="sr-only" role="status">{{ submitting ? 'Comprobando credenciales.' : '' }}</p>
    </form>
    <nav class="auth-links" aria-label="Navegación de acceso">
      <RouterLink to="/registro">Crear una cuenta</RouterLink>
      <RouterLink to="/">Regresar al inicio</RouterLink>
    </nav>
  </main>
</template>
