# Zendure para Gladys Assistant

Conecte sus baterías solares **Zendure SolarFlow / Hyper** a Gladys Assistant.
La integración lee la telemetría (nivel de batería, potencias de carga y
descarga, salida hacia la casa y producción solar) desde la nube de Zendure y
— opcionalmente — directamente desde el **broker MQTT local** de cada
dispositivo, para actualizaciones rápidas y resistentes sin conexión a
internet, con respaldo automático en la nube. Los valores son de solo lectura.

Cada batería se lee y se controla a través de su
**API local** (zenSDK) cuando responde en su red — como lo hace Home Assistant
— con la nube de Zendure como respaldo automático.

## Requisitos previos

- Una **cuenta Zendure**, con sus baterías ya configuradas y en línea en la
  aplicación Zendure.
- Gladys Assistant **5.1 o posterior**.

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

### API local (zenSDK, activada por defecto)

Las baterías SolarFlow (800, 800 Pro, 1600 AC+, 2400 AC, 2400 AC+, 2400 Pro
— todos los modelos compatibles salvo el Hyper 2000) ofrecen una pequeña **API HTTP en su red
doméstica**, llamada zenSDK. Es lo que usa la integración oficial de Home
Assistant para estos modelos: ni MQTT ni la nube. Con **Usar la API local de
las baterías** activado (por defecto), la integración lee cada batería a través
de ella cada 5 segundos, y también envía por ella los comandos de las escenas y
los widgets.

- **Requisitos previos**: la batería y el host de Gladys en la **misma red**
  (el contenedor debe poder alcanzar la dirección IP de la batería: sin Wi-Fi
  de invitados aislado ni VLAN de por medio), y un firmware reciente:
  actualice la batería desde la aplicación Zendure si su API local no
  responde. Los pasos propios de un modelo, si los hay, están en la
  [wiki de Zendure-HA](https://github.com/Zendure/Zendure-HA/wiki) (p. ej. su
  [página del SolarFlow 800](https://github.com/Zendure/Zendure-HA/wiki/SolarFlow-800)).
- **Dirección**: la integración toma la dirección IP de la batería de la nube
  de Zendure. Cuando la nube no la da, prueba el nombre mDNS de la batería
  `zendure-<modelo>-<número de serie>.local`, que rara vez se resuelve dentro
  de un contenedor Docker: rellene entonces **Direcciones de la API local** con
  pares `número de serie=dirección IP`, separados por comas (p. ej.
  `HOA1NAH4N123456=192.168.1.42`). Dar una IP fija a sus baterías en el router
  ayuda.
- **Respaldo automático**: una batería que falla tres peticiones seguidas pasa
  enseguida a su broker MQTT local si lo activó; a la nube de Zendure solo
  pasa tras 90 segundos sin respuesta (un corte breve del Wi-Fi no ocupa la
  conexión a la nube), y vuelve en cuanto su API local responde de nuevo. Al
  arrancar, una batería tiene los mismos 90 segundos para dar su primera
  respuesta. Una batería que nunca respondió
  simplemente sigue en la nube, sin insignia de aviso.
- **La nube queda en reposo**: cuando todas las baterías responden en local, la
  integración no se conecta en absoluto al broker de la nube de Zendure, y Home
  Assistant (u otra aplicación) con la misma cuenta Zendure conserva la única
  conexión a la nube de la cuenta.

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

Con la API local, **Local** significa que su API local o su broker local
sirve el dispositivo. El motivo del estado degradado indica qué fuente local
se ha callado.

## Control desde las escenas

Gladys aún no tiene una funcionalidad de consigna para baterías: las baterías se
controlan desde las **escenas** (y desde el widget del panel). En una escena,
añada una acción de la categoría **Integraciones**.

| Acción                           | Efecto                                                     |
| -------------------------------- | ---------------------------------------------------------- |
| **Ajustar el límite de salida**  | Potencia máxima entregada al hogar (W)                     |
| **Ajustar el límite de carga**   | Potencia máxima tomada de la red, carga AC (W)             |
| **Ajustar el modo AC**           | Cargar desde la red o descargar hacia el hogar             |
| **Ajustar los niveles de carga** | Objetivo de carga (70-100 %) y mínimo de descarga (0-50 %) |

La integración protege la batería:

- un límite se limita a la potencia nominal de la batería (p. ej. 800 W de
  salida en una SolarFlow 800 Pro);
- los límites de potencia se envían en "modo inteligente", guardados en memoria
  en lugar de escribirse en la flash de la batería (los cambios frecuentes la
  desgastarían);
- un mismo ajuste no puede cambiar más de una vez cada 3 s (límites de
  potencia) o 30 s (modo AC, niveles de carga): una escena que lo intenta antes
  falla indicando el tiempo de espera;
- un valor que la batería ya aplica no se vuelve a enviar (la salida de acción
  **Comando enviado** es entonces falsa);
- los niveles de carga se rechazan hasta que la batería informa de los suyos
  (su escala difiere según el firmware).

El comando pasa por el broker que sirve la batería en ese momento (local o
nube); el nuevo valor aparece con el siguiente informe de la batería.

El disparador **Accesibilidad de una batería** inicia una escena cuando una
batería deja de informar en todas las fuentes, o vuelve a hacerlo (API local o
MQTT local). Sus variables dan el nombre de la batería, el nuevo estado y la fuente
de telemetría.

## Widgets del panel

En el editor del panel hay cuatro widgets disponibles (Gladys 5.1 o
posterior):

- **Batería Zendure**: una batería, elegida en los ajustes del widget. Su nivel
  y sus cuatro potencias siguen la batería en directo; debajo, su fuente
  (local, nube, respaldo, inaccesible), la energía almacenada, los límites de
  salida y de carga, el modo AC y los niveles de carga que informa. Los botones
  **Límites de potencia** y **Modo y niveles** abren un formulario rellenado
  con los valores actuales: cambie lo necesario y confirme. Se aplican las
  mismas protecciones que en las acciones de escena.
- **Grupo de baterías**: varias baterías sumadas bajo el nombre que elija:
  nivel medio (ponderado por la capacidad de los packs cuando todas son
  conocidas), potencias totales, energía almacenada y una línea por batería
  coloreada según su fuente. Deje la lista de baterías vacía para tomar todas
  las baterías de la cuenta.
- **Instalación Zendure**: toda la instalación en una tarjeta. Elija la
  **Instalación eléctrica**: _Monofásica_ suma las baterías elegidas (ninguna:
  todas); _Trifásica_ toma las baterías de las listas **Baterías de la fase
  L1**, **L2** y **L3**. La tarjeta muestra los totales de la instalación
  (nivel ponderado por la capacidad de los packs, carga, descarga, solar,
  salida al hogar, energía almacenada), luego en trifásica una línea por fase
  (`⌂` salida al hogar, `↑` carga, `↓` descarga, `☀` solar, en W) y el
  **Equilibrio de fases**: la diferencia entre la salida al hogar más alta y
  la más baja, en naranja por encima de la **Alerta de desequilibrio** (500 W
  por defecto). Debajo: energía almacenada sobre la capacidad conocida, tiempo
  restante a la potencia actual, número de baterías por fuente (local, nube,
  inaccesible) y líneas de alerta para las baterías inaccesibles, los
  respaldos en la nube y una batería puesta en dos fases, en ninguna o
  eliminada. Una batería inaccesible conserva su nivel y su energía
  almacenada, pero sus últimas potencias quedan fuera de las sumas.
- **Energía de hoy**: la energía del día desde la medianoche local, con la
  misma elección de instalación y las mismas listas de fases: cargada,
  descargada, solar y salida al hogar (kWh), una línea por fase en trifásica
  con la diferencia entre fases, y un gráfico de la salida al hogar cada 30
  minutos (una curva por fase). El día empieza a la medianoche de la **Zona
  horaria** del widget (un nombre IANA, `Europe/Paris` por defecto: Gladys no
  da su zona horaria a una integración). Las cifras vienen de los contadores
  de energía de la integración (guardados en `/data` con una instantánea cada
  30 minutos, conservada 26 horas): cuentan desde el primer informe del día,
  que indica la línea **Contado desde** (por ejemplo tras una primera
  instalación por la mañana).

**Ejemplo trifásico:** 17 baterías en L1, L2 y L3. Añada un widget
**Instalación Zendure**, ponga la **Instalación eléctrica** en _Trifásica_ y
marque en **Baterías de la fase L1** las seis baterías conectadas a L1 (por
ejemplo dos 2400 AC, una 2400 Pro, dos 800 Pro y un 800 sin batería), en
**L2** las seis de L2 y en **L3** las cinco de L3. La tarjeta muestra los
totales, una línea por fase como `L1 (6) · 60 %` —
`⌂ 1890 · ↑ 500 · ↓ 1000 · ☀ 1400 W`, y `Equilibrio de fases` —
`Δ 1490 W · L1 la más alta` en naranja por encima del umbral. Añada un widget
**Energía de hoy** con las mismas tres listas para los kWh del día. Una
instalación monofásica conserva el ajuste por defecto y deja las listas
vacías. El widget **Grupo de baterías** sigue disponible para cualquier otra
agrupación.

Cada widget solo muestra lo que la batería tiene: un SolarFlow 800 usado sin
pack de batería conserva su solar, su salida al hogar y su límite de salida
(sin nivel, sin cifras de carga ni botón **Modo y niveles**), y un modelo
acoplado en AC (1600 AC+, 2400 AC, 2400 AC+) no tiene mosaico solar. Mientras
la batería carga o descarga, el widget muestra el tiempo restante hasta su
objetivo de carga o su mínimo de descarga, tal como lo informa la batería (o
calculado a partir de su capacidad cuando no lo da). Un grupo deja fuera las
baterías sin pack de su nivel medio y de su energía almacenada, y un grupo de
tales dispositivos solo muestra sus potencias.

## Un solo consumidor de la nube por cuenta Zendure

Zendure solo permite **un consumidor de la nube por cuenta** a la vez. Si otra
aplicación usa la conexión a la nube de la misma cuenta (Home Assistant, una
segunda instancia de Gladys…), ambas se disputan la conexión y la telemetría se
vuelve intermitente. Para cualquier segundo consumidor, prefiera el **MQTT
local** — el broker local no tiene ese límite. La integración avisa una vez en
sus registros cuando detecta este fenómeno de toma de la conexión.

Con la **API local** activada (por defecto), la integración solo se conecta al
broker de la nube de Zendure mientras una batería lo necesita, y se desconecta
5 minutos después de que la última batería que lo necesitaba vuelva a una
fuente local: si sus
baterías responden en local, Home Assistant y Gladys ya no se disputan la
conexión a la nube.

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
- **Una batería sigue en la nube aunque su API local debería funcionar.** Al
  arrancar, los registros listan cada batería que no responde, con la
  dirección probada y el motivo, p. ej. `local http: Garage (dCLTD95V) not
answering at 192.168.1.42 (from the cloud): EHOSTUNREACH`. `ENOTFOUND` en un
  nombre `.local` significa que el mDNS no se resuelve en el contenedor:
  indique su dirección en **Direcciones de la API local**. `EHOSTUNREACH`,
  `ECONNREFUSED` o `no answer within 2 s` significan que el contenedor no
  alcanza la batería (otra red, VLAN, cortafuegos) o que su firmware aún no
  tiene API local. Cada 5 minutos, una línea `telemetry(local http):` resume
  qué baterías responden.

### Diagnóstico

Dos botones de solo lectura, en la pestaña **Configuración** de la
integración, reconstruyen todo el panorama a petición, sin rebuscar en los
registros. Ninguno escribe en una batería ni cambia su transporte.

- **Diagnóstico de las baterías**: un informe de texto de la instalación — la
  versión de la integración, la configuración (nunca la clave de la nube), la
  API de la nube de Zendure, cada broker (conectado o no, reconexiones de los
  últimos 5 minutos, broker de la nube en reposo porque todas las baterías son
  locales, avisos de toma de sesión), el sondeo de la API local, y luego un
  bloque por batería: la fuente que la sirve y por qué, la antigüedad de sus
  últimos datos en cada fuente, la dirección de su API local (de las opciones,
  de la nube o mDNS) y su estado, los packs, la entrada solar, los ajustes que
  informa (límites, modo AC, niveles de carga), el tiempo restante y los
  contadores de energía. Elija una batería en la lista **Batería** (las
  baterías creadas en Gladys) para describir solo esa; para una batería no
  creada en Gladys, escriba su nombre o número de serie en el campo de abajo.
- **Probar la API local de una batería**: lee una vez, ahora, `GET
/properties/report` en la dirección que usa la integración, y muestra el
  tiempo de respuesta, el origen de la dirección y todas las propiedades que
  devuelve la batería — o el error exacto con una pista (`ENOTFOUND` en un
  nombre `.local`: rellene **Direcciones de la API local**; `EHOSTUNREACH`,
  `ECONNREFUSED` o un tiempo agotado: red o firmware).

Por defecto, los números de serie se acortan (`WOB1…0159`) y las direcciones
locales se sustituyen por `<local-ip>`: pegue el informe tal cual en una
[issue de GitHub](https://github.com/Terdious/gladys-zendure/issues), entre dos
líneas de tres comillas invertidas. **Mostrar los números de serie y
direcciones locales** los muestra completos, solo para sus propias
comprobaciones: no publique esa versión. Ningún informe contiene nunca la clave
de la nube ni una contraseña. Ambos informes se escriben también, ocultados,
en los registros de la integración.
