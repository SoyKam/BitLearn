
import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import './style.css'

// Crear la aplicación Vue
const app = createApp(App)

// Crear la instancia de Pinia
const pinia = createPinia()

// Registrar Pinia en Vue
app.use(pinia)

// Montar la aplicación
app.mount('#app')
