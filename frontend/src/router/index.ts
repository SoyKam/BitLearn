import { createRouter, createWebHistory } from 'vue-router'
import WelcomeView from '../views/WelcomeView.vue'
import { authGuard } from './auth.guard'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'welcome',
      component: WelcomeView,
    },
    { path: '/cursos', name: 'courses', component: () => import('../views/CoursesView.vue') },
    { path: '/cursos/:slug', name: 'course-detail', component: () => import('../views/CourseDetailView.vue') },
    { path: '/registro', name: 'register', component: () => import('../views/RegisterView.vue'), meta: { guestOnly: true } },
    { path: '/iniciar-sesion', name: 'login', component: () => import('../views/LoginView.vue'), meta: { guestOnly: true } },
    { path: '/perfil', name: 'profile', component: () => import('../views/ProfileView.vue'), meta: { requiresAuth: true } },
  ],
})

router.beforeEach(authGuard)

export default router
