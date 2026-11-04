<script setup lang="ts">
import { computed, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '../stores/auth.store'
import { useDashboardStore } from '../stores/dashboard.store'
const auth = useAuthStore()
const store = useDashboardStore()
watch(() => auth.isAuthenticated ? auth.user?.id : null, id => { if (id) void store.loadDashboard() }, { immediate: true })
const curve = computed(() => store.retention?.points.map(p => `${50 + p.daysAhead * 16},${230 - p.estimatedRetentionPercent * 2}`).join(' '))
const formatDate = (value: string) => new Intl.DateTimeFormat('es', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(value))
</script>
<template>
  <main class="courses-page dashboard-page" aria-labelledby="dashboard-title" :aria-busy="store.loading">
    <h1 id="dashboard-title">Mi dashboard</h1>
    <nav class="auth-links" aria-label="Navegación del dashboard">
      <RouterLink to="/repasos">Centro de repasos</RouterLink>
      <RouterLink to="/cursos">Explorar cursos</RouterLink>
      <RouterLink to="/perfil">Mi perfil</RouterLink>
    </nav>
    <button class="button" :disabled="store.loading" @click="store.reloadDashboard()">Actualizar dashboard</button>
    <p v-if="store.loading" role="status">Cargando dashboard…</p>
    <p v-if="store.error" role="alert">{{ store.error }}</p>
    <RouterLink v-if="!auth.isAuthenticated" to="/iniciar-sesion?redirect=/dashboard">Iniciar sesión nuevamente</RouterLink>
    <template v-if="auth.isAuthenticated && store.ownerId === auth.user?.id && store.statistics && store.retention">
      <dl class="dashboard-stats">
        <div><dt>Lecciones completadas</dt><dd>{{ store.statistics.summary.completedLessons }} de {{ store.statistics.summary.totalLessons }}</dd></div>
        <div><dt>Progreso general</dt><dd>{{ store.statistics.summary.completionPercent.toFixed(2) }} %</dd></div>
        <div><dt>Flashcards estudiadas</dt><dd>{{ store.statistics.summary.studiedFlashcards }}</dd></div>
        <div><dt>Repasos pendientes</dt><dd>{{ store.statistics.summary.dueReviews }}</dd></div>
        <div><dt>Repasos realizados</dt><dd>{{ store.statistics.summary.totalReviews }}</dd></div>
      </dl>
      <section class="catalog">
        <h2>Progreso por curso</h2>
        <p v-if="!store.statistics.courses.length">No hay cursos disponibles.</p>
        <div v-for="course in store.statistics.courses" :key="course.courseId" class="course-card">
          <h3>{{ course.courseTitle }}</h3>
          <label :for="`course-progress-${course.courseId}`">{{ course.completedLessons }} de {{ course.totalLessons }} lecciones · {{ course.completionPercent.toFixed(2) }} %</label>
          <progress :id="`course-progress-${course.courseId}`" :value="course.completionPercent" max="100">{{ course.completionPercent }} %</progress>
        </div>
      </section>
      <section class="catalog">
        <h2>Retención estimada</h2>
        <p v-if="store.isEmpty">Todavía no hay suficientes repasos para generar una proyección.</p>
        <template v-else>
          <p>Promedio estimado actual: {{ store.retention.averageRetentionNowPercent?.toFixed(2) }} % · {{ store.retention.modeledCards }} tarjetas.</p>
          <p>Referencia: {{ formatDate(store.retention.asOf) }}. Promedio simple, suponiendo que no realizas nuevos repasos.</p>
          <svg class="retention-chart" viewBox="0 0 580 285" role="img" aria-labelledby="curve-title curve-description">
            <title id="curve-title">Proyección estimada de retención durante 30 días</title>
            <desc id="curve-description">Porcentaje estimado frente al tiempo futuro en días. Los valores exactos están en la tabla siguiente.</desc>
            <path d="M50 30 V230 H530" fill="none" stroke="currentColor"/>
            <g v-for="n in [0, 50, 100]" :key="n"><text x="0" :y="235-n*2">{{ n }} %</text></g>
            <polyline :points="curve" fill="none" stroke="#a34000" stroke-width="3"/>
            <g v-for="p in store.retention.points" :key="p.daysAhead">
              <circle :cx="50+p.daysAhead*16" :cy="230-p.estimatedRetentionPercent*2" r="4" fill="#161110"/>
              <text :x="50+p.daysAhead*16" :y="p.daysAhead === 1 ? 263 : 247" text-anchor="middle">{{ p.daysAhead }}</text>
            </g>
            <text x="220" y="282">Tiempo futuro (días)</text>
          </svg>
          <table class="retention-table"><caption>Proyección sin nuevos repasos</caption>
            <thead><tr><th scope="col">Horizonte</th><th scope="col">Retención estimada</th></tr></thead>
            <tbody><tr v-for="p in store.retention.points" :key="p.daysAhead"><th scope="row">{{ p.daysAhead === 0 ? 'Hoy' : p.daysAhead + ' días' }}</th><td>{{ p.estimatedRetentionPercent.toFixed(2) }} %</td></tr></tbody>
          </table>
        </template>
        <p class="feedback">Esta proyección es una estimación matemática basada en los intervalos SM-2. No representa una medición real de tu memoria.</p>
        <p>El 50 % al alcanzar el intervalo es una elección matemática ilustrativa; los porcentajes no están calibrados con observaciones individuales.</p>
        <p v-if="store.retention.nextScheduledReviewAt">Próxima revisión programada: {{ formatDate(store.retention.nextScheduledReviewAt) }}. Es la próxima revisión futura registrada entre las tarjetas estudiadas.</p>
        <p v-else>No hay una próxima revisión futura registrada.</p>
        <RouterLink to="/repasos">Ir al centro de repasos</RouterLink>
      </section>
    </template>
  </main>
</template>
