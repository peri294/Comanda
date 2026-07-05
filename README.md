# QR Coffee Shop (PPR)

Un sistema de gestión de cafetería en tiempo real con arquitectura cliente-servidor, diseñado para coordinar pedidos entre clientes, cocina y mostrador de forma fluida.

![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Socket.io](https://img.shields.io/badge/Socket.io-010101?style=for-the-badge&logo=socket.io&logoColor=white)

## 🎯 Descripción
QR Coffee Shop es un sistema integral que digitaliza el proceso de toma de pedidos. Permite a los clientes realizar pedidos desde sus mesas mediante códigos QR, mientras la cocina y el mostrador reciben actualizaciones instantáneas, eliminando cuellos de botella en la comunicación.

## 🚀 Características Principales
* **Comunicación en Tiempo Real:** Actualizaciones inmediatas entre vistas mediante WebSockets (`Socket.io`).
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
   - **Desde celulares en la misma red (simula el QR real):** abrir `http://<IP-de-tu-PC>:5173/?view=client&table=3` (Vite muestra esa URL como "Network" al arrancar). El frontend deduce solo la dirección del backend a partir del host, sin configurar IPs; si el backend vive en otro host/puerto, se puede sobreescribir con la variable `VITE_BACKEND_URL` al levantar el frontend. La primera vez, Windows puede pedir permiso de firewall para Node — aceptarlo.
5. **Login de personal:** Las pantallas de Cocina y Mostrador piden una contraseña compartida por rol. Por defecto en desarrollo: `cocina123` (cocina) y `mostrador123` (mostrador). Para un despliegue real, sobreescribilas con las variables de entorno `KITCHEN_PASSWORD` y `COUNTER_PASSWORD` al levantar el backend.

## 📝 Licencia
Este proyecto es parte del portfolio de desarrollo de [peri294](https://github.com/peri294).
