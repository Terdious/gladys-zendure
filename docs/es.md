# Zendure para Gladys Assistant

Conecte sus baterías solares **Zendure SolarFlow / Hyper** a Gladys Assistant.
La integración lee la telemetría (nivel de batería, potencias de carga y
descarga, salida hacia la casa y producción solar) desde la nube de Zendure y
— opcionalmente — directamente desde el **broker MQTT local** de cada
dispositivo, para actualizaciones rápidas y resistentes sin conexión a
internet, con respaldo automático en la nube. Los valores son de solo lectura.

## Requisitos previos

- Una **cuenta Zendure**, con sus baterías ya configuradas y en línea en la
  aplicación Zendure.
- Gladys Assistant **4.86 o posterior**.

## Modelos compatibles

SolarFlow 800, SolarFlow 800 Pro, SolarFlow 1600, SolarFlow 2400,
SolarFlow 2400 AC, SolarFlow 2400 Pro y Hyper 2000 (experimental — la
correspondencia de la telemetría está pendiente de confirmación por un probador
de la comunidad).

## Funcionalidades

Cada batería se crea con diez funcionalidades de solo lectura, en las
categorías de energía de Gladys (gráficos de energía, historial, paneles):

| Funcionalidad                  | Categoría de Gladys             | Unidad |
| ------------------------------ | ------------------------------- | ------ |
| Nivel de batería               | Almacenamiento en batería       | %      |
| Potencia de carga              | Almacenamiento en batería       | W      |
| Potencia de descarga           | Almacenamiento en batería       | W      |
| Potencia de salida del hogar   | Sensor de salida del hogar      | W      |
| Potencia de entrada solar      | Sensor de producción de energía | W      |
| Energía cargada                | Almacenamiento en batería       | kWh    |
| Energía descargada             | Almacenamiento en batería       | kWh    |
| Energía de salida del hogar    | Sensor de salida del hogar      | kWh    |
| Energía solar                  | Sensor de producción de energía | kWh    |
| Energía restante de la batería | Almacenamiento en batería       | kWh    |

Zendure solo informa de potencias: las cuatro funcionalidades de **energía**
(kWh) las calcula la integración, que acumula cada potencia en el tiempo. Son
índices acumulados, guardados en el volumen de datos de la integración para que
un reinicio no los ponga a cero; un silencio de más de 5 minutos (batería
desconectada, broker caído) se descarta en lugar de estimarse. Gladys convierte
el índice de **energía solar** en sus gráficos de producción. La **energía
restante** es el nivel de batería multiplicado por la capacidad de los packs que
declara la batería (AB1000, AB2000, AB3000, packs integrados); queda vacía hasta
que la batería envía la lista de sus packs.

Desde la versión 1.3.0, el nivel de batería es el de un **almacenamiento en
batería**, no la pila de un dispositivo que hay que cambiar: Gladys ya no
cuenta su batería doméstica en sus alertas de batería baja. Una batería creada
con una versión anterior conserva sus categorías anteriores hasta que aplique
la nueva definición: en la pestaña **Descubrir**, haga clic en **Actualizar**
en la batería (marcada como **Ya añadido**). Las funcionalidades se actualizan
en el mismo lugar, por lo que se conservan su historial, las escenas y los
paneles. Ese mismo **Actualizar** añade las funcionalidades de energía a una
batería creada antes de la versión 1.5.0.

## Obtener su clave de la nube de Zendure

La integración se autentica ante la nube de Zendure con una **clave de
autorización** (un token base64) que usted genera una sola vez desde la
aplicación móvil Zendure:

1. Abra la aplicación **Zendure** e inicie sesión con su cuenta.
2. Vaya a la sección desarrollador / integración Home Assistant de la
   aplicación y genere (o copie) su **clave de autorización** (también llamada
   "clave HA").
3. Copie esa clave.

> La clave es un secreto vinculado a su cuenta Zendure: manténgala privada.
> Gladys la almacena cifrada y nunca la escribe en los registros.

## Configuración

1. Abra la pestaña **Configuración** de la integración en Gladys.
2. Pegue su clave en **Clave de autorización de la nube de Zendure**.
3. Ajuste el **Intervalo de actualización** (segundos) — la frecuencia con la
   que se refresca la telemetría cuando no llegan actualizaciones en tiempo
   real. El valor por defecto (30 s) es adecuado.
4. (Opcional) Active **Activar el MQTT local (zenSDK)** — vea más abajo.
5. (Opcional) Elija el idioma de los **Nombres de las funcionalidades** (inglés
   por defecto): se aplica a las baterías que cree a partir de ahora.
6. Haga clic en **Guardar configuración**. Sus baterías aparecen en la pestaña
   **Descubrir**, listas para añadirse.

### MQTT local (recomendado si lo utiliza)

Cuando activa el MQTT local en la aplicación Zendure (modo desarrollador), cada
dispositivo publica su telemetría en un broker local de su red. Con **Activar
el MQTT local (zenSDK)** en Gladys, la integración lee desde ese broker:

- **Más rápido**: los valores locales se actualizan cada 1–3 s en lugar de
  unos 30 s a través de la nube.
- **Resistente**: la telemetría sigue llegando durante una caída de la nube de
  Zendure o de internet.
- **Respaldo automático**: si un dispositivo deja de publicar en el broker
  local, la integración pasa sola a la nube y vuelve a lo local en cuanto se
  reanudan los mensajes locales — sin ninguna acción por su parte.

## Insignias de transporte

Cada dispositivo muestra una insignia que indica **cómo se le alcanza en este
momento**:

- **Local** (verde) — servido por su broker MQTT local (lo normal cuando el
  MQTT local está activado).
- **Nube** (azul) — servido por la nube de Zendure (lo normal cuando el MQTT
  local está desactivado).
- **Nube + punto naranja (degradado)** — el dispositivo _debería_ estar en
  local pero está temporalmente en el respaldo en la nube (su broker local dejó
  de publicar). Pase el ratón por encima de la insignia para ver el motivo.
  Desaparece por sí solo cuando el dispositivo vuelve a publicar en local.
- **Inaccesible** (rojo) — la nube de Zendure indica que el dispositivo está
  desconectado, o no publica en ninguna fuente.

## Un solo consumidor de la nube por cuenta Zendure

Zendure solo permite **un consumidor de la nube por cuenta** a la vez. Si otra
aplicación usa la conexión a la nube de la misma cuenta (Home Assistant, una
segunda instancia de Gladys…), ambas se disputan la conexión y la telemetría se
vuelve intermitente. Para cualquier segundo consumidor, prefiera el **MQTT
local** — el broker local no tiene ese límite. La integración avisa una vez en
sus registros cuando detecta este fenómeno de toma de la conexión.

## Actualizar la integración

**Instalada desde el catálogo** (el caso habitual): Gladys consulta el store
con regularidad. Cuando sale una nueva versión, la integración muestra la
insignia **"Actualización disponible"** (también contada junto a
**Integraciones** en el menú), y su pestaña **Supervisión** indica la versión
ofrecida, con un enlace a sus notas de versión. Haga clic en **Actualizar**:
Gladys descarga la nueva imagen **y** aplica el nuevo manifiesto — los nuevos
campos de configuración aparecen solos, no hay nada que volver a pegar. Su
configuración y sus dispositivos se conservan.

Gladys puede tardar hasta una hora y media aproximadamente en detectar una
nueva versión (actualización del índice del store). **"Forzar actualización"**
lo comprueba de inmediato: lee la última versión publicada y descarga su
imagen.

**Instalada en modo desarrollador** (manifiesto pegado a mano): **"Forzar
actualización"** solo vuelve a descargar la imagen de la etiqueta instalada, y
la versión mostrada y los campos de configuración provienen del manifiesto
pegado — vuelva a pegar el manifiesto actualizado para obtener los nuevos
campos.

## Solución de problemas

- **Una batería no se descubre.** Abra la pestaña **Registros**: una línea
  `Unsupported Zendure model skipped: productModel "..."` indica el nombre de
  modelo exacto que devuelve la nube de Zendure. Abra una issue en
  [gladys-zendure](https://github.com/Terdious/gladys-zendure/issues) con ese
  nombre para que se añada el modelo.
- **Un dispositivo no muestra ningún valor (o va más lento que los demás)
  mientras el resto funciona.** Revise su insignia de transporte. Si ha pasado
  a **Nube (degradado)** con el MQTT local activado, puede que su firmware haya
  dejado de publicar en local sin avisar. En la aplicación Zendure, ponga el
  **control MQTT de ese dispositivo en OFF**, guarde y vuelva a ponerlo en
  **ON** — vuelve a publicar en menos de un minuto. Mientras tanto, la
  integración pasa por la nube y vuelve a lo local automáticamente.
- **`Too Many Requests` en los registros.** La integración espacia sus
  actualizaciones por debajo del límite de peticiones del núcleo de Gladys y se
  regula sola si hace falta; las ráfagas ocasionales no tienen consecuencias.
  Un flujo persistente suele deberse a una **segunda instancia de la
  integración** (por ejemplo, un contenedor de producción y otro de pruebas en
  paralelo) que comparte el mismo presupuesto del núcleo — mantenga solo una.
- **Todo está en silencio justo después de la configuración.** Compruebe que la
  clave de la nube es correcta: una clave no válida o caducada muestra el
  estado "La nube de Zendure no está disponible o la clave de la nube no es
  válida." en la pantalla de configuración.
- **Detalle completo.** Defina `LOG_LEVEL=debug` y lea los registros de la
  integración en su pestaña **Registros** (o con `docker logs` en el host). Cada
  cambio de fuente de telemetría se registra en una línea `telemetry:`.
