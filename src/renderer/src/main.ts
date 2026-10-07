import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './app/App.vue';
import './styles/main.css';

/**
 * Applies the persisted theme before mounting.
 *
 * Mounting first and setting `<html data-theme>` afterwards shows the default dark
 * theme for one frame on every light-theme launch. A flash on startup reads as a
 * rendering bug rather than as a theme, and it is the one visual defect a user sees
 * before they have done anything.
 *
 * The cost is one IPC round trip before first paint. Main sets the window's
 * `backgroundColor` from the same setting, so the two agree and nothing is visible
 * either way. When there is no preload — a bare renderer in a test — the app still
 * mounts, in its default theme.
 */
async function bootstrap(): Promise<void> {
  const persisted = window.tabby ? await window.tabby.db.getSettings() : null;
  if (persisted?.ok) {
    document.documentElement.dataset['theme'] = persisted.value.theme;
  }
  createApp(App).use(createPinia()).mount('#app');
}

void bootstrap();
