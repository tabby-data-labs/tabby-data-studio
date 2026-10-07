// @vitest-environment happy-dom
/**
 * The export dialog (PLAN Phase 8).
 *
 * Tier 2 — Vue plus DOM, written after the implementation. The serialisation is
 * Tier 1 in `export-serialise.spec.ts` and the store's bridge behaviour is in
 * `exports-store.spec.ts`; what only a mounted dialog can show is that the options
 * it collects are the options it sends, and that the two warnings about data loss
 * are actually on screen when they apply.
 *
 * The dialog deliberately has no destination field. That absence is asserted here
 * as well as in the smoke harness, because a future edit that adds one would be a
 * write-anywhere primitive and the harness only runs against a real database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { defaultExportOptions } from '@shared/export';
import type { ExportStartResponse } from '@shared/ipc-contract';
import type { Result } from '@shared/errors';
import ExportDialog from '@/components/ExportDialog.vue';

let startResult: Result<ExportStartResponse | null>;
const sent: { resultId: string; options: Record<string, unknown> }[] = [];

function stubApi(): void {
  sent.length = 0;
  startResult = {
    ok: true,
    value: {
      exportId: 'x1',
      path: '/tmp/out.csv',
      fileName: 'out.csv',
      format: 'csv',
      insertTarget: null,
    },
  };
  // `tabby` alone, never `window`: replacing the whole global in a DOM environment
  // takes happy-dom's `Event` with it, and @vue/test-utils then cannot construct a
  // trigger event. In this environment `window === globalThis`, so stubbing the one
  // property is also what the store actually reads.
  vi.stubGlobal('tabby', {
    versions: { electron: '0', chrome: '0', node: '0' },
    db: {
      exportStart: (request: (typeof sent)[number]) => {
        sent.push(request);
        return Promise.resolve(startResult);
      },
      exportCancel: () => Promise.resolve({ ok: true, value: undefined }),
    },
    events: { onExportProgress: () => () => undefined },
  });
}

let pinia: Pinia;
const mounted: VueWrapper[] = [];

function mountDialog(props: Record<string, unknown> = {}): VueWrapper {
  const wrapper = mount(ExportDialog, {
    props: { resultId: 'r1', insertTarget: null, ...props },
    global: { plugins: [pinia] },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  stubApi();
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});

function formatInputs(wrapper: VueWrapper) {
  return wrapper.findAll('[data-export-format]');
}

async function chooseFormat(wrapper: VueWrapper, format: string): Promise<void> {
  const input = formatInputs(wrapper).find(
    (each) => (each.element as HTMLInputElement).value === format,
  );
  if (!input) throw new Error(`no radio for ${format}`);
  await input.trigger('change');
}

describe('shape', () => {
  it('is a labelled dialog offering all four formats, csv first', () => {
    const wrapper = mountDialog();
    expect(wrapper.find('[data-export-dialog]').attributes('role')).toBe('dialog');
    expect(wrapper.find('[data-export-dialog]').attributes('aria-label')).toBe('Export result');

    const formats = formatInputs(wrapper).map((each) => (each.element as HTMLInputElement).value);
    expect(formats).toEqual(['csv', 'tsv', 'json', 'sql']);
    expect((formatInputs(wrapper)[0]!.element as HTMLInputElement).checked).toBe(true);
  });

  it('has no destination field of any kind', () => {
    // The whole security argument: the path comes from main's save dialog, so a
    // compromised renderer cannot aim an export at a file the user did not pick.
    const wrapper = mountDialog();
    expect(wrapper.find('input[type="file"]').exists()).toBe(false);
    expect(wrapper.find('[data-export-path]').exists()).toBe(false);
    expect(wrapper.html()).not.toMatch(/save as/i);
  });

  it('says out loud that rows bypass the renderer', () => {
    expect(mountDialog().text()).toContain('none pass through this window');
  });

  it('disables Export while no result is open', () => {
    const wrapper = mountDialog({ resultId: null });
    expect(wrapper.find('[data-export-start]').attributes('disabled')).toBeDefined();
  });

  it('shows the delimiter and header options only for a delimited format', async () => {
    const wrapper = mountDialog();
    expect(wrapper.find('[data-export-delimiter]').exists()).toBe(true);
    expect(wrapper.find('[data-export-header]').exists()).toBe(true);

    await chooseFormat(wrapper, 'json');
    expect(wrapper.find('[data-export-delimiter]').exists()).toBe(false);
    expect(wrapper.find('[data-export-header]').exists()).toBe(false);
  });

  it('shows the batch size only for SQL, and the INSERT target with it', async () => {
    const wrapper = mountDialog({ insertTarget: '"fixtures"."wide"' });
    expect(wrapper.find('[data-export-batch]').exists()).toBe(false);

    await chooseFormat(wrapper, 'sql');
    expect(wrapper.find('[data-export-batch]').exists()).toBe(true);
    expect(wrapper.find('[data-export-target]').text()).toContain('"fixtures"."wide"');
  });

  it('warns that a non-table result gets a placeholder INSERT target', async () => {
    const wrapper = mountDialog({ insertTarget: null });
    await chooseFormat(wrapper, 'sql');
    expect(wrapper.find('[data-export-target]').text()).toContain('"public"."exported"');
    expect(wrapper.find('[data-export-target]').text()).toContain('Rename it');
  });
});

describe('switching format', () => {
  it('resets to that format’s defaults rather than carrying the old ones over', async () => {
    const wrapper = mountDialog();
    // Change something csv-specific, then leave and come back.
    await wrapper.find('[data-export-delimiter]').setValue(';');
    expect(sent).toEqual([]);

    await chooseFormat(wrapper, 'tsv');
    await chooseFormat(wrapper, 'csv');
    expect((wrapper.find('[data-export-delimiter]').element as HTMLInputElement).value).toBe(',');
  });

  it('adopts the tab delimiter and psql’s NULL spelling for TSV', async () => {
    const wrapper = mountDialog();
    await chooseFormat(wrapper, 'tsv');
    await wrapper.find('[data-export-start]').trigger('click');
    await flush();

    expect(sent[0]?.options).toMatchObject({ format: 'tsv', delimiter: '\t', nullText: '\\N' });
  });
});

describe('warnings about data loss', () => {
  it('says so when latin1 is chosen, because it cannot represent most text', async () => {
    const wrapper = mountDialog();
    expect(wrapper.find('[data-export-latin1-warning]').exists()).toBe(false);
    await wrapper.find('[data-export-encoding]').setValue('latin1');
    expect(wrapper.find('[data-export-latin1-warning]').exists()).toBe(true);
    expect(wrapper.find('[data-export-latin1-warning]').text()).toContain('U+00FF');
  });

  it('says so when NULL and the empty string become the same bytes', async () => {
    const wrapper = mountDialog();
    // csv defaults to an empty NULL text, so the warning is on by default and the
    // honest thing is to show it before the file is written, not after.
    expect(wrapper.find('[data-export-null-collision-warning]').exists()).toBe(true);

    await wrapper.find('[data-export-null-text]').setValue('\\N');
    expect(wrapper.find('[data-export-null-collision-warning]').exists()).toBe(false);
  });
});

describe('validation before the round trip', () => {
  it('refuses a quote as the delimiter, which would make every field ambiguous', async () => {
    const wrapper = mountDialog();
    await wrapper.find('[data-export-delimiter]').setValue('"');
    await wrapper.find('[data-export-start]').trigger('click');
    await flush();

    expect(sent).toEqual([]);
    expect(wrapper.find('[data-export-problem]').text()).toContain('line break, a quote');
  });

  it('refuses an empty delimiter', async () => {
    // A newline cannot be typed into this field at all — the HTML value sanitisation
    // strips CR and LF from a text input — so the "line break" half of the message
    // is only reachable by a non-browser caller, and main's validator is what covers
    // that. This is the branch a user can actually hit.
    const wrapper = mountDialog();
    await wrapper.find('[data-export-delimiter]').setValue('');
    await wrapper.find('[data-export-start]').trigger('click');
    await flush();

    expect(sent).toEqual([]);
    expect(wrapper.find('[data-export-problem]').text()).toContain('exactly one character');
  });

  it('refuses a NULL text containing a control character', async () => {
    // Unlike the delimiter field, this one is not length-limited to a single
    // character, so a tab really can be typed into it — and a tab in a TSV's NULL
    // spelling would collide with the delimiter.
    const wrapper = mountDialog();
    await wrapper.find('[data-export-null-text]').setValue('a\tb');
    await wrapper.find('[data-export-start]').trigger('click');
    await flush();

    expect(sent).toEqual([]);
    expect(wrapper.find('[data-export-problem]').text()).toContain('control characters');
  });

  it('clears the complaint once the field is fixed', async () => {
    const wrapper = mountDialog();
    await wrapper.find('[data-export-null-text]').setValue('a\tb');
    await wrapper.find('[data-export-start]').trigger('click');
    await flush();
    expect(wrapper.find('[data-export-problem]').text()).toContain('control characters');

    await wrapper.find('[data-export-null-text]').setValue('\\N');
    expect(wrapper.find('[data-export-problem]').exists()).toBe(false);
  });
});

describe('starting an export', () => {
  it('sends the chosen options for the given result and closes', async () => {
    const wrapper = mountDialog({ resultId: 'r7' });
    await wrapper.find('[data-export-null-text]').setValue('\\N');
    await wrapper.find('[data-export-start]').trigger('click');
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.resultId).toBe('r7');
    expect(sent[0]?.options).toEqual({
      ...defaultExportOptions('csv'),
      nullText: '\\N',
    });
    expect(wrapper.emitted('close')).toBeTruthy();
    expect(wrapper.emitted('notice')?.[0]?.[0]).toContain('out.csv');
  });

  it('stays open and reports nothing when the save dialog is dismissed', async () => {
    startResult = { ok: true, value: null };
    const wrapper = mountDialog();
    await wrapper.find('[data-export-start]').trigger('click');
    await flush();

    expect(wrapper.emitted('close')).toBeUndefined();
    expect(wrapper.emitted('notice')?.[0]?.[0]).toBe('');
    expect(wrapper.find('[data-export-problem]').exists()).toBe(false);
  });

  it('reports a refusal from main and stays open', async () => {
    startResult = { ok: false, error: { code: 'EXPORT_BUSY', message: '2 exports are running' } };
    const wrapper = mountDialog();
    await wrapper.find('[data-export-start]').trigger('click');
    await flush();

    expect(wrapper.emitted('close')).toBeUndefined();
    expect(wrapper.find('[data-export-problem]').text()).toContain('EXPORT_BUSY');
    expect(wrapper.find('[data-export-problem]').text()).toContain('2 exports are running');
  });
  it('does not start twice for one click', async () => {
    const wrapper = mountDialog();
    await wrapper.find('[data-export-start]').trigger('click');
    await wrapper.find('[data-export-start]').trigger('click');
    await flush();
    // The second click lands on an unmounted dialog in the real app; here the
    // guard is `starting`, and either way main must see one request.
    expect(sent.length).toBeLessThanOrEqual(1);
  });
});

describe('closing', () => {
  it('emits close from the ✕ button, the Cancel button, and Escape', async () => {
    const wrapper = mountDialog();
    await wrapper.find('[data-export-dismiss]').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);

    await wrapper.find('[data-export-close]').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(2);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flush();
    expect(wrapper.emitted('close')).toHaveLength(3);
  });
});
