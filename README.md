# BitLearn

**BitLearn** es una plataforma web de microaprendizaje de programación que busca reforzar el conocimiento mediante lecciones breves, tarjetas de estudio y repetición espaciada con el algoritmo **SuperMemo-2 (SM-2)**.

El proyecto contempla seguimiento del progreso, repasos personalizados y una estimación de la retención de conceptos a lo largo del tiempo.

## Tecnologías

- **Frontend:** Vue.js 3
- **Backend:** Node.js y Express
- **Base de datos:** PostgreSQL

**Estado del proyecto:** En desarrollo.

## Verificar PostgreSQL

Con las dependencias del backend instaladas, configura `DB_HOST`, `DB_PORT`,
`DB_NAME`, `DB_USER` y `DB_PASSWORD` en el entorno o en tu `backend/.env` privado,
tomando `backend/.env.example` como referencia. Usa los valores de conexión de tu
PC local o del túnel TCP desde Codespaces, según corresponda.

```bash
cd backend
npm run db:check
```

El comando reutiliza el pool y la validación TLS existentes (certificado
`backend/certs/bitlearn.crt` e identidad `bitlearn.internal`). Una sola consulta
de lectura identifica la base activa con `current_database()` y comprueba el
cifrado de la sesión en `pg_stat_ssl` mediante `pg_backend_pid()`, sin necesitar
permisos administrativos. Muestra la base de datos y el resultado TLS, cierra el
pool y termina con código `0` si la verificación es correcta o `1` ante errores.
No inicia Express ni ejecuta migraciones. No publiques tu `.env` ni credenciales.
