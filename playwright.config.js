import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  globalSetup: './tests/global-setup.js',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /(close-table|reports|write-failure|day-cycle|sessions)\.spec\.js/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Cobra una mesa: suma a la caja del día, cuyo monto controla tables.spec, así que
      // corre solo, cuando terminaron todos.
      name: 'close-table',
      testMatch: /close-table\.spec\.js/,
      dependencies: ['chromium'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Cobra una mesa y compara el reporte del día antes y después: nada más puede
      // cobrar en el medio.
      name: 'reports',
      testMatch: /reports\.spec\.js/,
      dependencies: ['close-table'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Hace fallar las escrituras de pedidos en la base: cualquier otro spec que pida en
      // paralelo fallaría, así que corre solo, cuando terminaron todos.
      name: 'write-failure',
      testMatch: /write-failure\.spec\.js/,
      dependencies: ['reports'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Cerrar el día bloquea todas las mesas: correrlo en paralelo con el resto rompería
      // a los demás specs, así que corre solo, cuando terminaron todos.
      name: 'day-cycle',
      testMatch: /day-cycle\.spec\.js/,
      dependencies: ['write-failure'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // "Cerrar Otras Sesiones" revoca las sesiones de personal de todos los specs: corre
      // último, cuando ya no queda ninguno que las necesite.
      name: 'sessions',
      testMatch: /sessions\.spec\.js/,
      dependencies: ['day-cycle'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
