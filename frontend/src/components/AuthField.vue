<script setup lang="ts">
const model = defineModel<string>({ required: true })
defineProps<{
  id: string
  label: string
  type?: 'text' | 'email' | 'password'
  autocomplete: string
  error?: string | undefined
  hint?: string
  maxlength?: number
}>()
</script>

<template>
  <div class="form-field">
    <label :for="id">{{ label }}</label>
    <input :id="id" v-model="model" :name="id" :type="type ?? 'text'" :autocomplete="autocomplete"
      :maxlength="maxlength" required :aria-invalid="Boolean(error)"
      :aria-describedby="[hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined" />
    <p v-if="hint" :id="`${id}-hint`" class="field-hint">{{ hint }}</p>
    <p v-if="error" :id="`${id}-error`" class="field-error">{{ error }}</p>
  </div>
</template>
