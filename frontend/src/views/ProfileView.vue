<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth.store'

const auth = useAuthStore()
const router = useRouter()
const registeredOn = computed(() => auth.user?.created_at
  ? new Intl.DateTimeFormat('es', { dateStyle: 'long' }).format(new Date(auth.user.created_at)) : null)

async function logout() {
  await auth.logout()
  await router.replace('/')
}
</script>

<template>
  <main class="auth-page" aria-labelledby="profile-title" :aria-busy="auth.loading">
    <RouterLink class="brand auth-brand" to="/"><span class="brand-mark" aria-hidden="true">&lt;/&gt;</span>BitLearn</RouterLink>
    <h1 id="profile-title">Mi perfil</h1>
    <p class="auth-intro">Tu espacio en BitLearn.</p>
    <p v-if="auth.loading" role="status">Comprobando tu sesión…</p>
    <div v-if="auth.error" class="feedback error" role="alert">
      <p>{{ auth.error.message }}</p>
      <button class="button" type="button" :disabled="auth.loading" @click="auth.fetchProfile()">Reintentar perfil</button>
    </div>
    <dl v-if="auth.isAuthenticated && auth.user" class="profile-details">
      <dt>Nombre</dt><dd>{{ auth.user.name }}</dd>
      <dt>Correo electrónico</dt><dd>{{ auth.user.email }}</dd>
      <template v-if="registeredOn"><dt>Fecha de registro</dt><dd>{{ registeredOn }}</dd></template>
    </dl>
    <nav class="auth-links" aria-label="Navegación de perfil">
      <button class="button primary" type="button" :disabled="auth.loading" @click="logout">Cerrar sesión</button>
      <RouterLink to="/">Regresar al inicio</RouterLink>
    </nav>
  </main>
</template>
