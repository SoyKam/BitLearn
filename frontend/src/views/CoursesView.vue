<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import CourseCard from '../components/CourseCard.vue'
import { useAuthStore } from '../stores/auth.store'
import { useCourseStore } from '../stores/course.store'

const auth = useAuthStore()
const catalog = useCourseStore()
const announcement = computed(() => {
  if (catalog.loading) return 'Cargando cursos...'
  if (catalog.error) return catalog.error.message
  if (catalog.isEmpty) return 'Todavía no hay cursos disponibles.'
  if (catalog.status === 'success') return 'Catálogo de cursos disponible.'
  return ''
})

onMounted(() => { void catalog.loadCourses() })
</script>

<template>
  <main class="courses-page" aria-labelledby="courses-title">
    <header>
      <RouterLink class="brand auth-brand" to="/"><span class="brand-mark" aria-hidden="true">&lt;/&gt;</span>BitLearn</RouterLink>
      <h1 id="courses-title">Explora nuestros cursos</h1>
      <p class="description">Comienza tu camino en el desarrollo web con HTML, CSS y JavaScript.</p>
      <nav class="auth-links" aria-label="Navegación del catálogo">
        <RouterLink to="/">Regresar al inicio</RouterLink>
        <RouterLink v-if="auth.isAuthenticated" to="/perfil">Ir a mi perfil</RouterLink>
        <template v-else>
          <RouterLink to="/registro">Crear cuenta</RouterLink>
          <RouterLink to="/iniciar-sesion">Iniciar sesión</RouterLink>
        </template>
      </nav>
    </header>

    <section class="catalog" aria-labelledby="catalog-title">
      <h2 id="catalog-title">Desarrollo Web</h2>
      <!-- La región permanece montada para anunciar también los cambios al reintentar. -->
      <p class="catalog-status" :class="{ error: catalog.error }" role="status" aria-atomic="true">{{ announcement }}</p>
      <button v-if="catalog.error || catalog.loading" class="button" type="button" :disabled="catalog.loading" @click="catalog.reloadCourses()">Reintentar</button>
      <div class="catalog-content" :aria-busy="catalog.loading">
        <p v-if="catalog.isEmpty">Estamos preparando nuevos contenidos para BitLearn.</p>
        <div v-else-if="catalog.status === 'success'" class="course-grid">
          <CourseCard v-for="course in catalog.courses" :key="course.id" :course="course" />
        </div>
      </div>
    </section>
  </main>
</template>
