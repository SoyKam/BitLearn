<script setup lang="ts">
import { computed, onUnmounted, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import LessonQuestion from '../components/LessonQuestion.vue'
import { useLessonStore } from '../stores/lesson.store'
import { useAuthStore } from '../stores/auth.store'

const route = useRoute()
const store = useLessonStore()
const auth = useAuthStore()
const id = computed(() => route.params.id)
watch(id, value => { void store.loadLesson(value) }, { immediate: true })
onUnmounted(() => store.clearLesson())
</script>

<template>
  <main class="courses-page course-detail" aria-labelledby="lesson-title">
    <header>
      <RouterLink class="brand auth-brand" to="/"><span class="brand-mark" aria-hidden="true">&lt;/&gt;</span>BitLearn</RouterLink>
      <h1 id="lesson-title">{{ store.lesson?.title ?? 'Lección' }}</h1>
      <p v-if="store.lesson" class="description">Curso: {{ store.lesson.course.title }} · Unidad: {{ store.lesson.unit.title }}</p>
      <nav class="auth-links" aria-label="Navegación de la lección">
        <RouterLink v-if="store.lesson" :to="{ name: 'course-detail', params: { slug: store.lesson.course.slug } }">Volver al curso y explorar lecciones</RouterLink>
        <RouterLink to="/repasos">Practicar con flashcards</RouterLink>
        <RouterLink to="/cursos">Ver catálogo</RouterLink>
        <RouterLink to="/mi-progreso">Mi progreso</RouterLink>
      </nav>
    </header>
    <p class="catalog-status" :class="{ error: store.error }" role="status" aria-atomic="true">{{ store.loading ? 'Cargando lección…' : store.error?.message ?? '' }}</p>
    <button v-if="store.error && store.error.status !== 400 && store.error.status !== 404" class="button" type="button" @click="store.reloadLesson(id)">Reintentar</button>
    <div :aria-busy="store.loading">
      <template v-if="store.lesson">
        <section class="catalog course-card" aria-labelledby="content-title">
          <h2 id="content-title">Contenido</h2>
          <p class="lesson-text">{{ store.lesson.content ?? 'Esta lección todavía no tiene contenido disponible.' }}</p>
        </section>
        <section class="catalog" aria-labelledby="activity-title">
          <h2 id="activity-title">Actividad</h2>
          <p v-if="!store.lesson.questions.length">Esta lección todavía no tiene actividades disponibles.</p>
          <template v-else>
            <p v-if="!auth.isAuthenticated" class="catalog-status">
              <RouterLink :to="{ name: 'login', query: { redirect: `/lecciones/${store.lesson.id}` } }">Inicia sesión para responder</RouterLink> y guardar tu progreso.
            </p>
            <LessonQuestion v-for="question in store.lesson.questions" :key="`${store.lesson.id}-${question.id}-${auth.user?.id ?? 'guest'}`"
              :question="question" :disabled="!auth.isAuthenticated || store.submitting || store.uncertain"
              :busy="store.submitting && store.questionId === question.id"
              :result="store.questionId === question.id ? store.result : null"
              :error="store.questionId === question.id ? store.answerError?.message ?? null : null"
              @answer="store.submitAnswer" />
            <div v-if="store.uncertain" class="feedback">
              <RouterLink to="/mi-progreso">Consultar mi progreso antes de responder de nuevo</RouterLink>
              <button class="button" type="button" @click="store.allowAnotherAttempt()">Habilitar otro intento de forma manual</button>
            </div>
          </template>
        </section>
      </template>
    </div>
  </main>
</template>
