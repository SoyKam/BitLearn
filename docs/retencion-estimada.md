# Proyección estimada de retención

SM-2 programa intervalos; no devuelve probabilidades calibradas de recuerdo.
Este modelo adicional usa R(t)=exp(-t/S), S=max(1,I)/ln(2).
I procede de interval_days en user_card_progress. t es la diferencia UTC entre
asOf y last_review_at, dividida por 86400000 milisegundos por día. S representa
una estabilidad ilustrativa, no medida. Los tiempos negativos se limitan a cero
(incluso diferencias grandes de reloj); fechas inválidas producen error seguro.
Las tarjetas sin último repaso se excluyen, sin crear estados.

R(0)=100 %, R(I)=50 % y R(2I)=25 % para I>=1. Con I=6, los horizontes desde
el repaso 0, 6 y 12 días dan esos porcentajes; con I=1, al día 1 se obtiene 50 %.
Un intervalo cero usa un día efectivo. El 50 % resulta de la elección matemática:
no es un umbral demostrado ni garantizado de recuerdo real, ni una salida de SM-2.

En cada horizonte 0, 1, 3, 7, 14 y 30 días desde asOf se calcula R(t+h) para
cada tarjeta y se obtiene un promedio simple, con igual peso. Por ejemplo 50 %
y 100 % promedian 75 %. Solo se redondea el contrato público a dos decimales.

GET /api/dashboard/retention requiere JWT y sesión activa, sin parámetros ni
cuerpo. Una sentencia SELECT parametrizada filtra por usuario y obtiene
statement_timestamp(), incluso sin filas de progreso. Devuelve referencia UTC,
cantidad de tarjetas, promedio actual, próxima fecha estrictamente futura entre
tarjetas estudiadas y puntos de la curva. Sin datos: cantidad cero, promedio y
próxima fecha null, puntos vacíos. No escribe ni modifica SM-2 o historial.

La proyección supone que no se realizan nuevos repasos. No simula respuestas,
no pondera dificultad ni considera diferencias individuales o contenido.
Los porcentajes no están calibrados con observaciones individuales.
**No representa una medición real de memoria ni una estimación científicamente
validada del recuerdo del estudiante.** Se interpreta únicamente como ilustración
matemática de disminución bajo supuestos simplificados.

La vista /dashboard presenta estadísticas existentes, barras de progreso, SVG,
tabla accesible, referencia temporal y aviso visible. Actualizar vuelve a consultar
ambos endpoints. El navegador no decide asOf ni calcula el modelo.
