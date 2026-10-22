<script setup lang="ts">
import { watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { useAuthStore } from './stores/auth.store'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
watch(() => auth.status, status => {
  if (route.meta.requiresAuth && (status === 'anonymous' || status === 'unchecked')) {
    void router.replace({ name: 'login', query: { redirect: '/perfil' } })
  }
})
</script>

<template>
  <div class="app-shell">
    <div v-if="auth.notice" class="feedback" role="status">
      <p>{{ auth.notice }}</p>
      <button v-if="auth.logoutUnconfirmed" class="button" type="button" :disabled="auth.loading" @click="auth.logout()">Reintentar cierre de sesión</button>
    </div>
    <p v-if="!route.matched.length && auth.loading" role="status">Comprobando sesión…</p>
    <RouterView />
  </div>
</template>
