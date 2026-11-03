<script setup lang="ts">
import { ref } from 'vue'
import type { AnswerInput, AnswerResult, LessonQuestion } from '../types/lesson'

defineProps<{ question: LessonQuestion; disabled: boolean; busy: boolean; result: AnswerResult | null; error: string | null }>()
const emit = defineEmits<{ answer: [input: AnswerInput] }>()
const selected = ref<number | null>(null)
</script>

<template>
  <form class="course-card question-card" :aria-busy="busy" @submit.prevent="selected !== null && emit('answer', { questionId: question.id, optionIndex: selected })">
    <fieldset :disabled="disabled">
      <legend>{{ question.prompt }}</legend>
      <label v-for="(option, index) in question.options" :key="index" class="answer-option">
        <input v-model="selected" type="radio" :name="`question-${question.id}`" :value="index" required>
        <span>{{ option }}</span>
      </label>
      <button class="button primary" type="submit" :disabled="disabled || selected === null">{{ busy ? 'Enviando…' : 'Enviar respuesta' }}</button>
    </fieldset>
    <div class="answer-feedback" role="status" aria-atomic="true">
      <p v-if="busy">Confirmando respuesta…</p>
      <template v-if="result">
        <p>{{ result.correct ? '¡Respuesta correcta!' : 'Respuesta incorrecta. Puedes revisar la explicación y volver a intentarlo.' }}</p>
        <p v-if="result.explanation" class="lesson-text">{{ result.explanation }}</p>
        <p v-if="result.completed">Lección completada.</p>
        <p>Intentos: {{ result.progress.attempts }} · Respuestas correctas: {{ result.progress.correctAnswers }}</p>
      </template>
      <p v-if="error" class="error">{{ error }}</p>
    </div>
  </form>
</template>
