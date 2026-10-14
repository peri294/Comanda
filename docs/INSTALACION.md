# Instalar Comanda en un local

Guía para dejar Comanda funcionando en una cafetería real: dónde instalarlo, cómo configurarlo, cómo es un día de trabajo y cómo cuidar los datos.

Cada local tiene su propia instalación: un servidor y una base de datos propios. No hay una cuenta central ni datos compartidos entre locales.

---

## 1. Qué hace falta

- **Un servidor que quede prendido** mientras el local está abierto. Puede ser un servicio en la nube (opción A) o una PC del local (opción B).
- **WiFi para los clientes** o datos móviles: el cliente abre el menú desde su celular.
- **Una tablet o PC para el mostrador** y, si se quiere, otra para la cocina. Alcanza con un navegador actualizado.
- **Una impresora** para los QR de las mesas (se imprimen una sola vez).

---

## 2. Opción A: en la nube (Render)

Es la opción recomendada: no depende de una PC del local, tiene HTTPS incluido y los clientes pueden pedir con datos móviles.

> El plan gratuito de Render (el de la demo pública) **no sirve para un local**: se duerme tras unos minutos sin uso y borra la base en cada reinicio. Hace falta un plan pago con **disco persistente**.

1. Crear el servicio en Render: *New → Web Service*, conectado a este repositorio, con un plan pago.
2. Configuración del servicio:
   - **Build command:** `npm run build`
   - **Start command:** `npm start`
   - **Health check path:** `/api/menu`
3. Agregar un **disco persistente** (*Disks → Add Disk*), montado en `/var/data`. Con 1 GB alcanza para años de pedidos y las fotos del menú.
4. Variables de entorno (*Environment*):

   | Variable | Valor |
   | --- | --- |
   | `NODE_VERSION` | `22` |
   | `KITCHEN_PASSWORD` | Contraseña de la cocina (larga: 12 caracteres o más) |
   | `COUNTER_PASSWORD` | Contraseña del mostrador (distinta de la de cocina) |
   | `DB_PATH` | `/var/data/comanda.db` (adentro del disco persistente) |
   | `TRUST_PROXY` | `1` |
   | `TZ` | La zona horaria del local, por ejemplo `America/Argentina/Buenos_Aires` |

   **No** definir `DEMO_MODE` ni `DEV_MODE`: el primero publica las contraseñas en la pantalla de inicio y el segundo deja expuesto un endpoint que borra la base.

5. Con el servicio en marcha, la dirección (`https://<nombre>.onrender.com`, o un dominio propio) es la que va en los QR.

El mismo esquema funciona en otros hostings con procesos Node persistentes y WebSockets (Railway, Fly.io, un VPS): lo que importa es que la base (`DB_PATH`) esté en un disco que no se borre.

---

## 3. Opción B: en una PC del local

Sirve si no se quiere depender de internet: todo pasa por el WiFi del local. Los clientes tienen que estar conectados a ese WiFi para pedir.

1. Instalar [Node.js](https://nodejs.org/) **22.13 o superior**.
2. Descargar el proyecto y compilarlo:
   ```bash
   npm run build
   ```
3. Arrancarlo con las variables de entorno. En Windows (PowerShell):
   ```powershell
   $env:KITCHEN_PASSWORD = "una-contraseña-larga-de-cocina"
   $env:COUNTER_PASSWORD = "otra-contraseña-larga-de-mostrador"
   $env:DB_PATH = "C:\Comanda\datos\comanda.db"
   npm start
   ```
   El server queda escuchando en el puerto 3001 (o el de la variable `PORT`).
4. Para que arranque solo al prender la PC y se reinicie si se cae, conviene un administrador de procesos como [PM2](https://pm2.keymetrics.io/).
5. La PC necesita una **IP fija en la red del local** (se configura en el router): esa dirección (`http://192.168.x.x:3001`) es la que va en los QR. Si la IP cambia, los QR impresos dejan de funcionar.
6. La primera vez, Windows pide permiso de firewall para Node: hay que aceptarlo para las redes privadas.

**HTTPS:** sin HTTPS, las contraseñas del personal viajan sin cifrar por el WiFi, y cualquiera conectado a la misma red podría verlas. Si el WiFi de los clientes es el mismo que el del personal, conviene poner un proxy con HTTPS delante del server (por ejemplo [Caddy](https://caddyserver.com/) con un dominio propio), o separar las redes: una para el personal y otra, aislada, para los clientes.

---

## 4. Primer arranque

1. Abrir la dirección del server: aparece la pantalla del personal, con los accesos a **Mostrador** y **Cocina**.
2. Entrar al Mostrador con su contraseña.
3. **Configuración:** nombre del local y logo. Aparecen en todas las pantallas, incluidas las de los clientes.
4. **Administrar Menú:**
   - Categorías: crear, renombrar, ordenar y elegirles un emoji. Arranca con cuatro de ejemplo; una categoría solo se puede borrar cuando no tiene productos.
   - Productos: nombre, descripción, precio, categoría y foto. El menú de ejemplo se puede editar o borrar.
5. **Mesas:** arranca con 12. Se agregan con "Agregar Mesa" y se dan de baja desde la tarjeta de cada mesa libre.
6. **Imprimir QR:** sale una hoja por mesa. El QR es fijo: se imprime una vez y queda pegado en la mesa. Imprimirlos desde la dirección definitiva del server (no desde `localhost`).
7. En la tablet de la cocina, abrir la dirección del server, elegir **Cocina** y entrar con su contraseña. La sesión queda guardada en esa tablet.

---

## 5. Un día de trabajo

1. **Abrir:** en el Mostrador, "Iniciar Día". Las mesas se habilitan para recibir pedidos.
2. **Llega un grupo:** el mozo le da el **código de la mesa**, los 4 números que muestra su tarjeta en el Mostrador. El cliente escanea el QR, ingresa el código y ve el menú. Cada celular lo ingresa una sola vez.
3. **Pedidos:** llegan a la cocina con aviso sonoro. La cocina los pasa a "En preparación", "Listo" y, cuando salen a la mesa, entregados.
4. **Cuenta:** el cliente la pide desde el celular (efectivo o tarjeta) y el Mostrador recibe el aviso. Se cobra con el medio habitual del local y se confirma en el Mostrador ("Cobrar Efectivo" / "Cobrar con Tarjeta", o "Confirmar Cobro y Cerrar Mesa" desde el detalle de la mesa). Al cobrar, la mesa queda libre y su código cambia: los celulares del grupo anterior pierden el acceso.
5. **Cerrar:** "Cerrar Día" bloquea las mesas libres; las que todavía tienen clientes se bloquean al cobrarlas. "Cerrar Caja" registra el arqueo del turno.
6. **Reportes:** ventas por día, productos más vendidos, ticket promedio y cierres de caja, exportables a CSV.

Si un código de mesa se filtró (por ejemplo, alguien que ya se fue sigue pidiendo), el botón de la llave en la tarjeta de la mesa lo cambia en el momento. Si lo que se filtró es el link del QR, el botón de regenerar QR lo invalida, y hay que imprimir el QR nuevo.

Ante una tablet perdida o alguien que dejó de trabajar, "Cerrar Otras Sesiones" desconecta todas las demás pantallas. Si además la contraseña se conoció, hay que cambiarla en las variables de entorno y reiniciar el server.

---

## 6. Copias de seguridad

Todo vive en un solo archivo de base de datos: menú, fotos, mesas, pedidos, ventas y cierres de caja.

- **Descargar una copia:** Mostrador → Configuración → "Descargar copia de seguridad". Baja un archivo `comanda-AAAA-MM-DD.db`. Conviene hacerlo una vez por semana y guardarlo fuera del server (un pendrive, una carpeta en la nube).
- **Restaurar una copia:**
  1. Detener el server.
  2. Reemplazar el archivo de la base (el de `DB_PATH`) por la copia, con el mismo nombre. Si junto a la base hay archivos `-wal` y `-shm`, borrarlos.
  3. Arrancar el server.

  Las sesiones del personal no se guardan en la base: después de restaurar (o de cualquier reinicio) hay que volver a entrar con la contraseña.

---

## 7. Actualizar a una versión nueva

1. Descargar la copia de seguridad (por las dudas).
2. Actualizar el código (`git pull`, o en Render un deploy nuevo).
3. `npm run build` y reiniciar el server.

La base se migra sola al arrancar: las columnas y tablas nuevas se agregan sin tocar los datos.

---

## 8. Problemas frecuentes

| Síntoma | Causa probable |
| --- | --- |
| El server no arranca: "Faltan KITCHEN_PASSWORD y/o COUNTER_PASSWORD" | Faltan las variables de entorno de las contraseñas. |
| El QR abre en la PC pero no en los celulares | Se imprimió desde `localhost`, o la PC del server cambió de IP. Imprimir de nuevo desde la dirección definitiva. |
| El cliente ve "Esta mesa no está disponible" | El QR es de una mesa dada de baja o se regeneró: imprimir el QR nuevo. |
| El cliente ve "Mesa no habilitada" | Falta "Iniciar Día", o la mesa se bloqueó desde su tarjeta. |
| "Demasiados intentos" al ingresar el código | Hubo 10 códigos incorrectos para esa mesa desde la misma conexión: esperar 15 minutos, o que el mozo verifique el código de la tarjeta. |
| Las ventas de un día aparecen en otro | La zona horaria del server no es la del local: definir `TZ`. |
| Las pantallas del personal vuelven al login | El server se reinició, o alguien usó "Cerrar Otras Sesiones". |
| Aviso rojo "Sin conexión" y botones deshabilitados | Esa pantalla perdió el contacto con el server (WiFi o server caído). Se reconecta sola y se pone al día; mientras tanto no se puede tocar nada, para que ninguna acción se pierda. Los clientes ven que tienen que pedir ayuda al mozo. |
