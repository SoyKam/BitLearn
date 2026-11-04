<script setup lang="ts">
import { reviewGrades } from '../types/review'
import type { DueFlashcard } from '../types/review'
defineProps<{ card: DueFlashcard; revealed: boolean; disabled: boolean; busy: boolean }>()
defineEmits<{ reveal: []; grade: [quality: number] }>()
</script>

<template>
  <section class="course-card study-card" aria-labelledby="study-title" :aria-busy="busy">
    <h2 id="study-title">Tu flashcard</h2>
    <p>Curso: {{ card.courseSlug }} · Lección: {{ card.lessonTitle }}</p>
    <p>{{ card.status === 'new' ? 'Nueva' : 'Vencida' }}</p>
    <h3>Pregunta</h3>
    <p class="lesson-text">{{ card.front }}</p>
    <button v-if="!revealed" class="button primary" type="button" :disabled="disabled" @click="$emit('reveal')">Mostrar respuesta</button>
    <div role="status" aria-live="polite">
      <template v-if="revealed"><h3>Respuesta</h3><p class="lesson-text">{{ card.back }}</p></template>
    </div>
    <fieldset :disabled="disabled || !revealed" class="review-grades">
      <legend>¿Cuánto recuerdas?</legend>
      <button v-for="grade in reviewGrades" :key="grade.quality" class="button" type="button" :aria-label="grade.label" @click="$emit('grade', grade.quality)">
        <strong>{{ grade.label }}</strong><span>{{ grade.description }}</span>
      </button>
    </fieldset>
  </section>
</template>
