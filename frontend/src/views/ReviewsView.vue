<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import { RouterLink } from 'vue-router'
import FlashcardStudy from '../components/FlashcardStudy.vue'
import { useAuthStore } from '../stores/auth.store'
import { useReviewStore } from '../stores/review.store'
import { qualityLabel } from '../types/review'
const auth = useAuthStore()
const store = useReviewStore()
const formatDate = (value: string) => new Intl.DateTimeFormat('es', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(value))
watch(() => auth.isAuthenticated ? auth.user?.id : null, id => {
  if (id) { void store.loadDueReviews(); void store.loadHistory() }
}, { immediate: true })
// Advertir al cerrar/recargar: no se persiste información privada ni se reconstruye un UUID perdido.
function beforeUnload(event: BeforeUnloadEvent) {
  if (store.pending) { event.preventDefault(); event.returnValue = '' }
}
window.addEventListener('beforeunload', beforeUnload)
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))
</script>

<template>
  <main class="courses-page course-detail reviews-page" aria-labelledby="reviews-title">
    <header>
      <RouterLink class="brand auth-brand" to="/"><span class="brand-mark" aria-hidden="true">&lt;/&gt;</span>BitLearn</RouterLink>
      <h1 id="reviews-title">Centro de repasos</h1>
      <p class="description">Recuerda lo aprendido con flashcards y repasos programados por SM-2.</p>
      <nav class="auth-links" aria-label="Navegación de repasos">
        <RouterLink to="/dashboard">Mi dashboard</RouterLink>
      <RouterLink to="/cursos">Explorar cursos</RouterLink><RouterLink to="/mi-progreso">Mi progreso</RouterLink><RouterLink to="/perfil">Mi perfil</RouterLink>
      </nav>
    </header>
    <p class="catalog-status">Si perdiste una confirmación al cerrar o recargar la página, consulta tu historial antes de iniciar otro repaso.</p>
    <RouterLink v-if="!auth.isAuthenticated || [store.loadError?.status, store.submitError?.status, store.historyError?.status].includes(401)" :to="{ name: 'login', query: { redirect: '/repasos' } }">Iniciar sesión nuevamente</RouterLink>
    <template v-if="auth.isAuthenticated && store.ownerId === auth.user?.id">
      <section class="catalog" aria-labelledby="due-title">
        <h2 id="due-title">Tarjetas disponibles en esta sesión: {{ store.due.length }}</h2>
        <p>Nuevas: {{ store.due.filter(card => card.status === 'new').length }} · Vencidas: {{ store.due.filter(card => card.status === 'due').length }}</p>
        <p v-if="store.loading" role="status">Cargando tarjetas pendientes…</p>
        <div v-if="store.loadError" role="alert" class="feedback error"><p>No se pudo actualizar la lista. {{ store.loadError.message }}</p></div>
        <button class="button" type="button" :disabled="store.loading || store.submitting || !!store.pending" @click="store.reloadDueReviews()">{{ store.loadError ? 'Reintentar pendientes' : 'Actualizar pendientes' }}</button>
        <div v-if="store.loaded && !store.loading && !store.loadError && !store.due.length" class="feedback">
          <p>No tienes repasos pendientes por ahora.</p>
          <p>Completa nuevas lecciones para desbloquear tarjetas o regresa cuando llegue tu próxima revisión.</p>
          <RouterLink to="/cursos">Explorar cursos</RouterLink>
        </div>
        <nav v-if="store.due.length > 1" class="auth-links" aria-label="Seleccionar flashcard">
          <button v-for="(card, index) in store.due" :key="card.flashcardId" type="button" class="button" :aria-pressed="store.selectedId === card.flashcardId"
            :disabled="store.loading || store.submitting || !!store.pending" @click="store.selectFlashcard(card.flashcardId)">Tarjeta {{ index + 1 }} · {{ card.lessonTitle }}</button>
        </nav>
        <FlashcardStudy v-if="store.selected" :card="store.selected" :revealed="store.revealed"
          :disabled="store.loading || store.submitting || !!store.pending || !!store.loadError" :busy="store.submitting"
          @reveal="store.revealAnswer()" @grade="store.submitReview" />
      </section>
      <p v-if="store.submitting" role="status">Confirmando repaso…</p>
      <div v-if="store.uncertain" role="alert" class="feedback">
        <p>No pudimos confirmar el resultado de este repaso.</p>
        <p>{{ store.submitError?.message }}</p>
        <p>La confirmación conserva la tarjeta y la calificación originales. Evita cerrar o recargar esta página hasta resolverla.</p>
        <button class="button primary" type="button" :disabled="store.submitting" @click="store.retryConfirmation()">Reintentar confirmación</button>
      </div>
      <p v-else-if="store.submitError" role="alert" class="feedback error">{{ store.submitError.message }}</p>
      <section v-if="store.result" class="feedback" role="status" aria-labelledby="result-title">
        <h2 id="result-title">Repaso registrado correctamente.</h2>
        <p v-if="store.result.replayed">Confirmación recuperada del repaso original.</p>
        <p>Calificación: {{ qualityLabel(store.result.quality) }}</p>
        <p>Factor de facilidad: {{ store.result.easeFactor.toFixed(2) }}</p>
        <p>Próximo intervalo: {{ store.result.intervalDays }} {{ store.result.intervalDays === 1 ? 'día' : 'días' }}</p>
        <p>Siguiente revisión: {{ formatDate(store.result.nextReviewAt) }}</p>
      </section>
      <section class="catalog" aria-labelledby="history-title" :aria-busy="store.historyLoading">
        <h2 id="history-title">Historial de repasos</h2>
        <p v-if="store.historyLoading" role="status">Cargando historial…</p>
        <p v-if="store.historyError" role="alert" class="feedback error">{{ store.historyError.message }}</p>
        <button class="button" type="button" :disabled="store.historyLoading" @click="store.loadHistory()">{{ store.historyError ? 'Reintentar historial' : 'Actualizar historial' }}</button>
        <template v-if="store.historyLoaded">
          <p v-if="!store.history.items.length">{{ store.history.total === 0 ? 'Todavía no has realizado repasos.' : 'No hay repasos en esta página.' }}</p>
          <ol class="course-units">
            <li v-for="item in store.history.items" :key="item.reviewId" class="course-card">
              <h3>{{ item.lessonTitle }}</h3><p>Curso: {{ item.courseSlug }}</p><p>{{ item.front }}</p>
              <p>{{ qualityLabel(item.quality) }} · {{ formatDate(item.reviewedAt) }}</p>
              <details><summary>Detalles del repaso</summary>
                <p>Factor anterior: {{ item.easeFactorBefore.toFixed(2) }} · Factor posterior: {{ item.easeFactorAfter.toFixed(2) }}</p>
                <p>Intervalo anterior: {{ item.intervalBeforeDays }} días · Intervalo posterior: {{ item.intervalAfterDays }} días</p>
                <p>Próxima revisión: {{ formatDate(item.nextReviewAt) }}</p>
              </details>
            </li>
          </ol>
          <nav class="auth-links" aria-label="Paginación del historial">
            <button class="button" type="button" :disabled="store.historyLoading || store.history.offset === 0" @click="store.loadHistory(Math.max(0, store.history.offset - 20))">Página anterior</button>
            <span>Página {{ Math.floor(store.history.offset / 20) + 1 }} · {{ store.history.total }} repasos</span>
            <button class="button" type="button" :disabled="store.historyLoading || store.history.offset + 20 >= store.history.total || store.history.offset + 20 > 10000" @click="store.loadHistory(store.history.offset + 20)">Página siguiente</button>
          </nav>
        </template>
      </section>
    </template>
  </main>
</template>
