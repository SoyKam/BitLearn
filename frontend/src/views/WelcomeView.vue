<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '../stores/auth.store'
import { checkHealth, type HealthStatus } from '../services/health.service'

type ConnectionState = 'loading' | HealthStatus
const auth = useAuthStore()

const connectionState = ref<ConnectionState>('loading')
const connectionMessages: Record<ConnectionState, string> = {
  loading: 'Comprobando conexión...',
  connected: 'API operativa · PostgreSQL conectado',
  'database-unavailable': 'API disponible · PostgreSQL desconectado',
  'connection-error': 'No se pudo conectar con la API. Inténtalo de nuevo.',
}

async function retryConnection() {
  if (connectionState.value === 'loading') return
  connectionState.value = 'loading'
  connectionState.value = await checkHealth()
}

onMounted(async () => {
  void auth.restoreSession()
  connectionState.value = await checkHealth()
})
</script>

<template>
  <main class="welcome" aria-labelledby="welcome-title">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">&lt;/&gt;</span>
      <h1 id="welcome-title">BitLearn</h1>
    </div>

    <p class="tagline">Aprende código, domina tu futuro.</p>
    <p class="description">
      Una plataforma de microaprendizaje para aprender desarrollo web mediante
      lecciones cortas y repasos inteligentes, paso a paso y a tu ritmo.
    </p>

    <nav class="auth-links welcome-links" aria-label="Catálogo de cursos">
      <RouterLink class="button" to="/cursos">Explorar cursos</RouterLink>
    </nav>

    <nav class="auth-links welcome-links" aria-label="Tu cuenta">
      <template v-if="auth.isAuthenticated">
        <RouterLink class="button primary" to="/perfil">Ir a mi perfil</RouterLink>
        <button class="button" type="button" :disabled="auth.loading" @click="auth.logout()">Cerrar sesión</button>
      </template>
      <template v-else>
        <RouterLink class="button primary" to="/registro">Crear cuenta</RouterLink>
        <RouterLink class="button" to="/iniciar-sesion">Iniciar sesión</RouterLink>
      </template>
    </nav>
    <div v-if="auth.status === 'unavailable'" class="feedback" role="status">
      <p>{{ auth.error?.message }}</p>
      <button class="button" type="button" :disabled="auth.loading" @click="auth.restoreSession(true)">Reintentar sesión</button>
    </div>

    <aside class="preview" aria-labelledby="preview-title">
      <h2 id="preview-title">Aprender hoy. Recordar mañana.</h2>
      <p>
        BitLearn utilizará repetición espaciada SM-2 para programar tus repasos.
        Esta funcionalidad está prevista para una próxima etapa y aún no está disponible.
      </p>
    </aside>

    <div class="connection">
      <p class="connection-status" role="status" aria-live="polite" aria-atomic="true">
        <span class="connection-dot" aria-hidden="true"></span>
        <span>{{ connectionMessages[connectionState] }}</span>
      </p>
      <button
        v-if="connectionState !== 'connected'"
        class="connection-retry"
        type="button"
        :disabled="connectionState === 'loading'"
        @click="retryConnection"
      >
        Reintentar conexión
      </button>
    </div>
  </main>
</template>
