<script setup lang="ts">
/**
 * Connection picker and editor.
 *
 * The smallest thing that makes a live database reachable from the UI: Phase 6
 * builds the schema explorer on top of an already-chosen connection, and Phase 7
 * the query console, so connection management has to exist somewhere and this is
 * where it lands.
 *
 * The password field is write-only by construction — main encrypts it and never
 * returns it, so there is nothing to pre-fill and no way for it to reach the DOM
 * twice. Leaving it blank on an existing connection keeps the stored credential,
 * which is what `SettingsStore.saveConnection` does.
 */
import { computed, reactive, ref } from 'vue';
import { useConnectionsStore } from '@/stores/connections';
import type { SslMode } from '@shared/domain';

const connections = useConnectionsStore();

const SSL_MODES: readonly SslMode[] = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'];

const editing = ref(false);
const form = reactive({
  id: '',
  name: '',
  host: 'localhost',
  port: 5432,
  database: '',
  user: '',
  password: '',
  sslMode: 'prefer' as SslMode,
  createdAt: 0,
  updatedAt: 0,
});

const isNew = computed(() => form.id === '');
const title = computed(() =>
  isNew.value ? 'New connection' : `Edit ${form.name || 'connection'}`,
);

function newConnection(): void {
  // Generated here rather than left blank so the payload always carries a real id
  // and a re-save can never be mistaken for a create.
  const id = crypto.randomUUID();
  Object.assign(form, {
    id,
    name: '',
    host: 'localhost',
    port: 5432,
    database: '',
    user: '',
    password: '',
    sslMode: 'prefer',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  editing.value = true;
}

function editSelected(): void {
  const current = connections.active;
  if (!current) return;
  Object.assign(form, { ...current, password: '' });
  editing.value = true;
}

function cancel(): void {
  editing.value = false;
}

async function save(): Promise<void> {
  const ok = await connections.save({
    connection: {
      id: form.id,
      name: form.name.trim(),
      host: form.host.trim(),
      port: form.port,
      database: form.database.trim(),
      user: form.user.trim(),
      sslMode: form.sslMode,
      createdAt: form.createdAt,
      updatedAt: form.updatedAt,
    },
    // Omitted entirely when blank: sending `''` would be ambiguous next to
    // "keep the stored credential".
    ...(form.password === '' ? {} : { password: form.password }),
  });
  if (ok) {
    form.password = '';
    editing.value = false;
  }
}

async function onOpen(): Promise<void> {
  if (connections.activeId) await connections.open(connections.activeId);
}

const formValid = computed(
  () =>
    form.name.trim() !== '' &&
    form.host.trim() !== '' &&
    form.database.trim() !== '' &&
    form.user.trim() !== '' &&
    Number.isInteger(form.port) &&
    form.port >= 1 &&
    form.port <= 65_535,
);
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-2 text-xs">
    <span class="text-muted">Connection</span>

    <select
      class="input min-w-[180px]"
      :value="connections.activeId ?? ''"
      :disabled="connections.busy"
      @change="connections.select(($event.target as HTMLSelectElement).value || null)"
    >
      <option value="" disabled>— none —</option>
      <option v-for="c in connections.list" :key="c.id" :value="c.id">
        {{ c.name }}{{ connections.isOpen(c.id) ? ' · open' : '' }}
      </option>
    </select>

    <button type="button" class="btn" :disabled="!connections.activeId" @click="onOpen">
      {{ connections.activeId && connections.isOpen(connections.activeId) ? 'Reopen' : 'Open' }}
    </button>
    <button
      type="button"
      class="btn"
      :disabled="!connections.activeId || connections.busy"
      @click="connections.activeId && connections.test(connections.activeId)"
    >
      Test
    </button>
    <button
      type="button"
      class="btn"
      :disabled="!connections.activeId || !connections.isOpen(connections.activeId)"
      @click="connections.activeId && connections.close(connections.activeId)"
    >
      Close
    </button>

    <span class="mx-1 h-4 w-px bg-line" />

    <button type="button" class="btn" @click="newConnection">New</button>
    <button type="button" class="btn" :disabled="!connections.active" @click="editSelected">
      Edit
    </button>
    <button
      type="button"
      class="btn btn-danger"
      :disabled="!connections.activeId"
      @click="connections.activeId && connections.remove(connections.activeId)"
    >
      Delete
    </button>

    <span v-if="connections.notice" class="text-ok">{{ connections.notice }}</span>
    <span v-if="connections.error" class="text-warn">
      {{ connections.error.code }}: {{ connections.error.message }}
    </span>
    <span v-else-if="connections.loadWarning" class="text-warn">
      {{ connections.loadWarning }}
    </span>

    <!-- The editor is inline rather than a dialog: a modal in Electron needs its
         own window or a focus trap, and neither is worth it for six fields. -->
    <div v-if="editing" class="basis-full rounded border border-line bg-surface p-3">
      <div class="mb-2 text-fg">{{ title }}</div>
      <div class="grid grid-cols-2 gap-2 md:grid-cols-3">
        <label class="field">
          <span>Name</span>
          <input v-model="form.name" class="input" placeholder="local dev" />
        </label>
        <label class="field">
          <span>Host</span>
          <input v-model="form.host" class="input" placeholder="localhost" />
        </label>
        <label class="field">
          <span>Port</span>
          <input v-model.number="form.port" class="input" type="number" min="1" max="65535" />
        </label>
        <label class="field">
          <span>Database</span>
          <input v-model="form.database" class="input" placeholder="app_db" />
        </label>
        <label class="field">
          <span>User</span>
          <input v-model="form.user" class="input" placeholder="postgres" />
        </label>
        <label class="field">
          <span>Password</span>
          <input
            v-model="form.password"
            class="input"
            type="password"
            :placeholder="isNew ? 'required if the server asks' : 'blank keeps the stored one'"
            autocomplete="off"
          />
        </label>
        <label class="field">
          <span>SSL mode</span>
          <select v-model="form.sslMode" class="input">
            <option v-for="mode in SSL_MODES" :key="mode" :value="mode">{{ mode }}</option>
          </select>
        </label>
      </div>
      <div class="mt-2 flex items-center gap-2">
        <button type="button" class="btn" :disabled="!formValid || connections.busy" @click="save">
          Save
        </button>
        <button type="button" class="btn" @click="cancel">Cancel</button>
        <span v-if="!formValid" class="text-muted">
          name, host, database, user and a port in 1–65535 are required
        </span>
      </div>
      <p class="mt-2 text-[10px] leading-relaxed text-muted">
        The password is encrypted with the OS keychain before it is written, and is refused outright
        when no keychain is available. It is never returned to this window.
      </p>
    </div>
  </div>
</template>

<style scoped>
.btn {
  border: 1px solid var(--color-line);
  border-radius: 4px;
  padding: 3px 8px;
  color: var(--color-fg);
  background: rgba(28, 58, 94, 0.25);
  cursor: pointer;
}
.btn:hover:not(:disabled) {
  background: rgba(59, 118, 240, 0.25);
}
.btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.btn-danger:hover:not(:disabled) {
  background: rgba(240, 59, 59, 0.28);
}
.input {
  border: 1px solid var(--color-line);
  border-radius: 4px;
  padding: 3px 6px;
  background: var(--color-surface);
  color: var(--color-fg);
  font: inherit;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.field > span {
  color: var(--color-muted);
  font-size: 10px;
}
</style>
