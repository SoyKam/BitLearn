<script setup lang="ts">
import { watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '../stores/auth.store'
import { useProgressStore } from '../stores/progress.store'

const auth = useAuthStore()
const progress = useProgressStore()
watch(() => auth.isAuthenticated ? auth.user?.id : null, id => {
  if (id) void progress.reloadProgress()
}, { immediate: true })
</script>

<template>
  <main class="courses-page course-detail" aria-labelledby="progress-title">
    <header>
      <RouterLink class="brand auth-brand" to="/"><span class="brand-mark" aria-hidden="true">&lt;/&gt;</span>BitLearn</RouterLink>
      <h1 id="progress-title">Mi progreso</h1>
      <nav class="auth-links" aria-label="Navegación del progreso">
        <RouterLink to="/repasos">Mis repasos</RouterLink>
        <RouterLink to="/cursos">Explorar cursos</RouterLink>
        <RouterLink to="/perfil">Mi perfil</RouterLink>
      </nav>
    </header>
    <p class="catalog-status" :class="{ error: progress.error }" role="status" aria-atomic="true">{{ progress.loading ? 'Cargando progreso…' : progress.error?.message ?? (progress.loaded ? 'Progreso actualizado.' : '') }}</p>
    <button class="button" type="button" :disabled="progress.loading" @click="progress.reloadProgress()">{{ progress.error ? 'Reintentar' : 'Actualizar progreso' }}</button>
    <section v-if="progress.loaded && progress.ownerId === auth.user?.id" class="catalog" aria-labelledby="summary-title">
      <h2 id="summary-title">Lecciones completadas: {{ progress.completedLessons }} de {{ progress.totalLessons }}</h2>
      <p v-if="progress.isEmpty">Todavía no tienes actividad registrada. Explora un curso para comenzar.</p>
      <ul v-else class="course-units" role="list">
        <li v-for="lesson in progress.lessons" :key="lesson.lessonId" class="course-card">
          <h3>Lección {{ lesson.lessonId }}</h3>
          <p>Curso: {{ lesson.courseSlug }}</p>
          <p>Intentos: {{ lesson.attempts }}</p>
          <p>Respuestas correctas: {{ lesson.correctAnswers }}</p>
          <p>{{ lesson.completedAt ? 'Completada' : 'En curso' }}</p>
          <nav class="auth-links" :aria-label="`Navegación de la lección ${lesson.lessonId}`">
            <RouterLink :to="{ name: 'lesson', params: { id: lesson.lessonId } }">Abrir lección {{ lesson.lessonId }}</RouterLink>
            <RouterLink :to="{ name: 'course-detail', params: { slug: lesson.courseSlug } }">Volver al curso</RouterLink>
          </nav>
        </li>
      </ul>
    </section>
  </main>
</template>
