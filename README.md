# QR Coffee Shop (PPR)

Un sistema de gestión de cafetería en tiempo real con arquitectura cliente-servidor, diseñado para coordinar pedidos entre clientes, cocina y mostrador de forma fluida.

![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Socket.io](https://img.shields.io/badge/Socket.io-010101?style=for-the-badge&logo=socket.io&logoColor=white)

## 🎯 Descripción
QR Coffee Shop es un sistema integral que digitaliza el proceso de toma de pedidos. Permite a los clientes realizar pedidos desde sus mesas mediante códigos QR, mientras la cocina y el mostrador reciben actualizaciones instantáneas, eliminando cuellos de botella en la comunicación.

## 🚀 Características Principales
* **Comunicación en Tiempo Real:** Actualizaciones inmediatas entre vistas mediante WebSockets (`Socket.io`).
* **Menú Administrable:** El mostrador gestiona productos, precios y stock ("Agotado") desde su panel; los clientes ven los cambios al instante, sin recargar.
* **Arquitectura Unificada:** Un único build de frontend que sirve para tres roles (Cliente, Cocina, Mostrador) mediante parámetros de consulta.
* **UI/UX Moderna:** Diseño inspirado en *Glassmorphism* con modo oscuro nativo.
* **Sistema de Notificaciones:** Sistema de audio sintético para alertas instantáneas en cocina y mostrador.

## 🏗️ Arquitectura
El sistema utiliza una arquitectura cliente-servidor eficiente:

```
                      +-------------------+
                      |   Servidor Node   |
                      | (Express/Sockets) |
                      +---------+---------+
                                |
        +-----------------------+-----------------------+
        |                       |                       |
+-------v-------+       +-------v-------+       +-------v-------+
|  Cliente (QR) |       | Cocina Screen |       | Mostrador UI  |
| (Mobile View) |       | (Order Board) |       |  (Dashboard)  |
+---------------+       +---------------+       +---------------+
```

## 🛠️ Stack Tecnológico
- **Frontend:** React (Vite), CSS Custom.
- **Backend:** Node.js, Express, Socket.io.
- **Persistencia:** SQLite embebido (módulo `node:sqlite`, sin dependencias externas) — mesas y pedidos sobreviven a un reinicio del servidor.
- **Comunicación:** WebSockets para baja latencia.

## 💻 Guía de Ejecución

1. **Requisitos:** Tener instalado [Node.js](https://nodejs.org/) **22.13 o superior** (el backend usa el módulo `node:sqlite` incluido en Node para persistir mesas y pedidos, sin dependencias nativas).
2. **Backend:**
   ```bash
   cd backend
   npm install
   npm run dev
   ```
3. **Frontend:**
   ```bash
   cd frontend
   npm install
   npm run dev
   ```
4. **Acceso:** Abrir `http://localhost:5173/` y usar los parámetros de vista (ej. `?view=client`, `?view=kitchen`, `?view=counter`).
   - **Desde celulares en la misma red (simula el QR real):** abrir `http://<IP-de-tu-PC>:5173/?view=client&table=3&t=<token>` (Vite muestra la dirección como "Network" al arrancar; el link completo con el token de cada mesa sale del botón de QR de la mesa en el Mostrador). El frontend deduce solo la dirección del backend a partir del host, sin configurar IPs; si el backend vive en otro host/puerto, se puede sobreescribir con la variable `VITE_BACKEND_URL` al levantar el frontend. La primera vez, Windows puede pedir permiso de firewall para Node — aceptarlo.
5. **Habilitar las mesas:** las mesas arrancan bloqueadas. En el Mostrador, "Iniciar Día" las habilita para recibir pedidos y "Cerrar Día" las vuelve a bloquear (las ocupadas, al cobrarlas).
6. **Login de personal:** Las pantallas de Cocina y Mostrador piden una contraseña compartida por rol. Por defecto en desarrollo: `cocina123` (cocina) y `mostrador123` (mostrador). Para un despliegue real, sobreescribilas con las variables de entorno `KITCHEN_PASSWORD` y `COUNTER_PASSWORD` al levantar el backend. Las sesiones no vencen solas: se cierran con "Salir", con "Cerrar Otras Sesiones" en el Mostrador (tablet perdida, alguien que dejó de trabajar) o al reiniciar el backend, que es lo que pasa al cambiar las contraseñas. Tras 5 contraseñas incorrectas desde la misma IP, el login se bloquea 15 minutos.

## 🧪 Tests

- **Unit tests** de las reglas de negocio y de las sesiones (`backend/*.test.js`, con `node:test`, sin levantar nada): `npm test --prefix backend` (o `npm run test:unit` desde la raíz).
- **E2E** (Playwright, en `tests/`): con el backend y el frontend corriendo en modo desarrollo, `npx playwright test` desde la raíz. Arrancan con `/api/test/reset`, que **borra la base**: para no perder tu estado local, levantá el backend con `DB_PATH` apuntando a una base aparte.

## ☁️ Despliegue

En producción todo corre como un solo servicio: el backend sirve el build del frontend en el mismo origen. Funciona en cualquier hosting con procesos Node persistentes y WebSockets (Render, Railway, Fly.io); no en funciones serverless.

```bash
npm run build   # instala dependencias y compila el frontend
npm start       # levanta el server (usa PORT si el hosting la define)
```

| Variable | Uso |
| --- | --- |
| `DEV_MODE=1` | Solo desarrollo (lo setea `npm run dev` vía `backend/.env.development`): habilita los endpoints de test, las contraseñas por defecto y el CORS abierto. **Nunca en un despliegue.** Sin esta variable el server arranca seguro por defecto. |
| `KITCHEN_PASSWORD` / `COUNTER_PASSWORD` | Contraseñas del personal. Obligatorias salvo con `DEV_MODE=1` o `DEMO_MODE=1`: sin ellas el server no arranca. |
| `TRUST_PROXY` | Cantidad de proxies delante del server (normalmente `1` en Render, Railway o Fly.io). Necesario para que el freno de intentos de login distinga a cada cliente por su IP real. |
| `DEMO_MODE=1` | Demo pública: el portal muestra las mesas y las contraseñas, y el estado vuelve a fábrica (con las mesas habilitadas) tras un rato sin uso. |
| `DEMO_IDLE_MINUTES` | Minutos sin actividad antes de reiniciar la demo (por defecto 30). |
| `DB_PATH` | Ruta del archivo SQLite. En modo demo puede vivir en un disco efímero. |
| `CORS_ORIGIN` | Solo si el frontend se publica en otro dominio (junto con `VITE_BACKEND_URL` al compilarlo). |

## 📝 Licencia
Este proyecto es parte del portfolio de desarrollo de [peri294](https://github.com/peri294).
