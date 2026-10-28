<script setup lang="ts">
import type { Course } from '../types/course'

defineProps<{ course: Course }>()
</script>

<template>
  <article class="course-card" :aria-labelledby="`course-${course.id}-title`">
    <h3 :id="`course-${course.id}-title`">{{ course.title }}</h3>
    <p v-if="course.description">{{ course.description }}</p>
    <p v-else>Descripción no disponible.</p>
  </article>
</template>
