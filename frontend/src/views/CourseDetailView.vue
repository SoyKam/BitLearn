<script setup lang="ts">
import { computed, onUnmounted, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useCourseStore } from '../stores/course.store'

const route = useRoute()
const catalog = useCourseStore()
const slug = computed(() => typeof route.params.slug === 'string' ? route.params.slug : '')
const announcement = computed(() => {
  if (catalog.detailLoading) return 'Cargando información del curso...'
  if (catalog.detailError) return catalog.detailError.message
  if (catalog.detailStatus === 'success') return 'Información del curso disponible.'
  return ''
})
const canRetry = computed(() => catalog.detailError
  && !['validation', 'not-found'].includes(catalog.detailError.kind))

watch(slug, value => { void catalog.loadCourseDetail(value) }, { immediate: true })
onUnmounted(() => catalog.clearCourseDetail())
</script>

<template>
  <main class="courses-page course-detail" aria-labelledby="course-title">
    <header>
      <RouterLink class="brand auth-brand" to="/"><span class="brand-mark" aria-hidden="true">&lt;/&gt;</span>BitLearn</RouterLink>
      <h1 id="course-title">{{ catalog.detail?.title ?? 'Detalle del curso' }}</h1>
      <p v-if="catalog.detail" class="description">{{ catalog.detail.description || 'Descripción no disponible.' }}</p>
      <nav class="auth-links" aria-label="Navegación del curso">
        <RouterLink to="/cursos">Volver al catálogo</RouterLink>
      </nav>
    </header>

    <p class="catalog-status" :class="{ error: catalog.detailError }" role="status" aria-atomic="true">{{ announcement }}</p>
    <button v-if="canRetry || catalog.detailLoading" class="button" type="button" :disabled="catalog.detailLoading" @click="catalog.reloadCourseDetail(slug)">Reintentar</button>
    <div class="catalog-content" :aria-busy="catalog.detailLoading">
      <section v-if="catalog.detail" class="catalog" aria-labelledby="units-title">
        <h2 id="units-title">Unidades y lecciones</h2>
        <p v-if="!catalog.detail.units.length" class="catalog-status">Este curso todavía no tiene unidades disponibles.</p>
        <ol v-else class="course-units" role="list">
          <li v-for="unit in catalog.detail.units" :key="unit.id" :value="unit.position">
            <article class="course-card" :aria-labelledby="`unit-${unit.id}-title`">
              <h3 :id="`unit-${unit.id}-title`">Unidad {{ unit.position }} — {{ unit.title }}</h3>
              <p v-if="!unit.lessons.length">Esta unidad todavía no tiene lecciones disponibles.</p>
              <ol v-else class="course-lessons" role="list">
                <li v-for="lesson in unit.lessons" :key="lesson.id" :value="lesson.position">
                  <span class="lesson-order">Lección {{ lesson.position }}:</span> {{ lesson.title }}
                </li>
              </ol>
            </article>
          </li>
        </ol>
      </section>
    </div>
  </main>
</template>
