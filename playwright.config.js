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
      testIgnore: /(day-cycle|sessions)\.spec\.js/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Cerrar el día bloquea todas las mesas: correrlo en paralelo con el resto rompería
      // a los demás specs, así que corre solo, cuando terminaron todos.
      name: 'day-cycle',
      testMatch: /day-cycle\.spec\.js/,
      dependencies: ['chromium'],
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
