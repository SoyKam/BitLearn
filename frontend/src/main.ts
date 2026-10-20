
import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import './style.css'

// Crear la aplicación Vue
const app = createApp(App)

// Crear la instancia de Pinia
const pinia = createPinia()

// Registrar Pinia en Vue
app.use(pinia)

// Registrar Vue Router en Vue
app.use(router)

// Montar la aplicación
app.mount('#app')
