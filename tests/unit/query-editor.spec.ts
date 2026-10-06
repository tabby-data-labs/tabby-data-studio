// @vitest-environment happy-dom
/**
 * The query editor component (PLAN Phase 7).
 *
 * Tier 2 under AGENTS.md — Vue plus DOM — so written after the implementation. The
 * lexer, the splitter and the highlight layer are all Tier 1 and tested test-first;
 * what only a mounted component can show is the wiring between them and the user:
 *
 *  - typing keeps the highlight layer character-identical to the textarea, which is
 *    the property the stacked-layer design stands or falls on;
 *  - Cmd+Enter runs the statement **at the caret**, Shift+Cmd+Enter runs the script,
 *    and a selection runs exactly what is selected;
 *  - Tab is left alone, so the pane cannot become a keyboard trap;
 *  - Cancel is inert unless something is actually on the server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import QueryEditor from '@/components/QueryEditor.vue';

interface Props {
  connectionId?: string | null;
  busy?: boolean;
  runningLabel?: string | null;
}

function mountEditor(props: Props = {}): VueWrapper {
  return mount(QueryEditor, {
    props: { connectionId: 'conn-1', busy: false, runningLabel: null, ...props },
    attachTo: document.body,
  });
}

function area(wrapper: VueWrapper): HTMLTextAreaElement {
  const found = wrapper.find('[data-sql-input]');
  expect(found.exists(), 'the textarea should exist').toBe(true);
  return found.element as HTMLTextAreaElement;
}

async function type(wrapper: VueWrapper, text: string): Promise<void> {
  const element = area(wrapper);
  element.value = text;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  await wrapper.vm.$nextTick();
}

/** Sets a selection the way a drag would, then reports what the editor sees. */
function select(wrapper: VueWrapper, start: number, end: number): void {
  const element = area(wrapper);
  element.selectionStart = start;
  element.selectionEnd = end;
}

async function press(
  wrapper: VueWrapper,
  key: string,
  mods: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {},
): Promise<void> {
  // No `cancelable` in these options: happy-dom's Event exposes it getter-only and
  // @vue/test-utils assigns every option onto the event it creates.
  await wrapper.find('[data-sql-input]').trigger('keydown', {
    key,
    metaKey: mods.meta === true,
    ctrlKey: mods.ctrl === true,
    shiftKey: mods.shift === true,
  });
}

let wrappers: VueWrapper[];

beforeEach(() => {
  wrappers = [];
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers = [];
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function tracked(wrapper: VueWrapper): VueWrapper {
  wrappers.push(wrapper);
  return wrapper;
}

describe('layout', () => {
  it('renders the textarea, the highlight layer, the gutter and the current-line rule', () => {
    const wrapper = tracked(mountEditor());
    expect(wrapper.find('[data-sql-input]').exists()).toBe(true);
    expect(wrapper.find('[data-highlight]').exists()).toBe(true);
    expect(wrapper.find('.gutter').exists()).toBe(true);
    expect(wrapper.find('.current-line').exists()).toBe(true);
  });

  it('numbers every line in the gutter, and grows with the text', async () => {
    const wrapper = tracked(mountEditor());
    expect(wrapper.find('.gutter-text').text()).toBe('1');

    await type(wrapper, 'select 1;\nselect 2;\nselect 3');
    expect(wrapper.find('.gutter-text').text()).toBe('1\n2\n3');

    await type(wrapper, 'a\n');
    // A trailing newline means the caret can sit on an empty line 2, so the gutter
    // has to show it or the numbers drift against the text.
    expect(wrapper.find('.gutter-text').text()).toBe('1\n2');
  });

  it('keeps the highlight layer character-identical to the textarea', async () => {
    const wrapper = tracked(mountEditor());
    for (const sql of [
      "select 'a;b' from t",
      'select 1;\nselect 2;',
      '-- a comment\nselect 1',
      '$$ body ; with $$',
      'select "Mixed Case", a::text',
      'ünïcødé 日本語',
      'a\r\nb',
    ]) {
      await type(wrapper, sql);
      const rendered = wrapper.find('[data-highlight]').element.textContent ?? '';
      expect(rendered, JSON.stringify(sql)).toBe(sql);
    }
  });

  it('adds the trailing-line guard only when the source ends in a newline', async () => {
    const wrapper = tracked(mountEditor());
    await type(wrapper, 'select 1');
    expect(wrapper.find('[data-highlight]').element.textContent).toBe('select 1');

    await type(wrapper, 'select 1\n');
    // The guard is one space, so textContent gains exactly one character. A `<pre>`
    // otherwise swallows the final line break and drifts a line behind the textarea.
    expect(wrapper.find('[data-highlight]').element.textContent).toBe('select 1\n ');
  });

  it('colours tokens, and leaves whitespace outside any span', async () => {
    const wrapper = tracked(mountEditor());
    await type(wrapper, 'select 1');
    const html = wrapper.find('[data-highlight]').element.innerHTML;
    expect(html).toContain('tok-keyword');
    expect(html).toContain('tok-number');
    expect(html).toContain('</span> <span');
  });
});

describe('statement reporting', () => {
  it('counts statements with the lexer, not by counting semicolons', async () => {
    const wrapper = tracked(mountEditor());
    const count = (): string =>
      wrapper.find('[data-statement-count]').attributes('data-statement-count') ?? '';

    await type(wrapper, '');
    expect(count()).toBe('0');
    await type(wrapper, 'select 1');
    expect(count()).toBe('1');
    await type(wrapper, 'select 1; select 2;');
    expect(count()).toBe('2');
    // The three cases that a naive split gets wrong.
    await type(wrapper, "select 'a;b'");
    expect(count()).toBe('1');
    await type(wrapper, 'select 1; -- a ; note');
    expect(count()).toBe('1');
    await type(wrapper, 'select $$ a ; b $$');
    expect(count()).toBe('1');
    await type(wrapper, '-- only a comment');
    expect(count()).toBe('0');
  });

  it('reports an unterminated literal instead of throwing it away', async () => {
    const wrapper = tracked(mountEditor());
    await type(wrapper, "select 'abc");
    const error = wrapper.find('[data-lex-error]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toMatch(/unterminated/i);
    // The text typed so far is still highlighted: the editor stays usable mid-edit.
    expect(wrapper.find('[data-highlight]').element.textContent ?? '').toBe("select 'abc");
  });

  it('reports no error for a complete script', async () => {
    const wrapper = tracked(mountEditor());
    await type(wrapper, "select 'abc'; select 2");
    expect(wrapper.find('[data-lex-error]').exists()).toBe(false);
  });
});

describe('running', () => {
  it('runs the statement at the caret on Cmd+Enter', async () => {
    const wrapper = tracked(mountEditor());
    await type(wrapper, 'select 1;\nselect 2;\nselect 3');
    select(wrapper, 14, 14);

    await press(wrapper, 'Enter', { meta: true });
    const emitted = wrapper.emitted('run');
    expect(emitted).toHaveLength(1);
    const statements = emitted![0]![0] as { text: string }[];
    expect(statements.map((statement) => statement.text)).toEqual(['select 2']);
  });

  it('runs the last statement from a caret at the very end of the script', async () => {
    // Where the caret lands after `.value` is assigned, and after a user finishes
    // typing. The final statement has no `;`, so its span ends at end-of-text and
    // the caret sits just past the last character — which must still count as
    // "inside" it, or finishing a query and pressing Cmd+Enter would do nothing.
    const wrapper = tracked(mountEditor());
    await type(wrapper, 'select 1; select 2');
    select(wrapper, 18, 18);
    await press(wrapper, 'Enter', { meta: true });
    const statements = wrapper.emitted('run')![0]![0] as { text: string }[];
    expect(statements.map((statement) => statement.text)).toEqual(['select 2']);
  });

  it('runs the statement at the caret on Ctrl+Enter too', async () => {
    const wrapper = tracked(mountEditor());
    await type(wrapper, 'select 1; select 2');
    select(wrapper, 12, 12);
    await press(wrapper, 'Enter', { ctrl: true });
    const statements = wrapper.emitted('run')![0]![0] as { text: string }[];
    expect(statements.map((statement) => statement.text)).toEqual(['select 2']);
  });

  it('runs the whole script on Shift+Cmd+Enter', async () => {
    const wrapper = tracked(mountEditor());
    await type(wrapper, 'select 1; select 2; select 3');
    select(wrapper, 0, 0);
    await press(wrapper, 'Enter', { meta: true, shift: true });
    const statements = wrapper.emitted('run')![0]![0] as { text: string }[];
    expect(statements.map((statement) => statement.text)).toEqual([
      'select 1',
      'select 2',
      'select 3',
    ]);
  });

  it('runs exactly what is selected, and nothing more', async () => {
    const wrapper = tracked(mountEditor());
    await type(wrapper, 'select 1; select 2; select 3');
    select(wrapper, 10, 28);
    await press(wrapper, 'Enter', { meta: true });
    const statements = wrapper.emitted('run')![0]![0] as { text: string }[];
    expect(statements.map((statement) => statement.text)).toEqual(['select 2', 'select 3']);
  });

  it('does not fire on a plain Enter, which has to insert a newline', async () => {
    const wrapper = tracked(mountEditor());
    await type(wrapper, 'select 1');
    await press(wrapper, 'Enter');
    expect(wrapper.emitted('run')).toBeUndefined();
  });

  it('emits nothing and says so when there is no statement at the cursor', async () => {
    const wrapper = tracked(mountEditor());
    await type(wrapper, '-- just a note');
    await press(wrapper, 'Enter', { meta: true });
    expect(wrapper.emitted('run')).toBeUndefined();
    expect(wrapper.text()).toContain('nothing to run at the cursor');
  });

  it('runs from the buttons as well as the keyboard', async () => {
    const wrapper = tracked(mountEditor());
    await type(wrapper, 'select 1; select 2');
    select(wrapper, 0, 0);
    await wrapper.find('[data-run]').trigger('click');
    expect((wrapper.emitted('run')![0]![0] as { text: string }[]).map((s) => s.text)).toEqual([
      'select 1',
    ]);

    await wrapper.find('[data-run-all]').trigger('click');
    expect((wrapper.emitted('run')![1]![0] as { text: string }[]).map((s) => s.text)).toEqual([
      'select 1',
      'select 2',
    ]);
  });

  it('explains the statement at the caret', async () => {
    const wrapper = tracked(mountEditor());
    await type(wrapper, 'select 1; select 2');
    select(wrapper, 12, 12);
    await wrapper.find('[data-explain]').trigger('click');
    const emitted = wrapper.emitted('explain');
    expect(emitted).toHaveLength(1);
    expect((emitted![0]![0] as { text: string }).text).toBe('select 2');
  });
});

describe('disabled states', () => {
  it('disables running with no connection open', () => {
    const wrapper = tracked(mountEditor({ connectionId: null }));
    expect((wrapper.find('[data-run]').element as HTMLButtonElement).disabled).toBe(true);
    expect((wrapper.find('[data-run-all]').element as HTMLButtonElement).disabled).toBe(true);
    expect((wrapper.find('[data-explain]').element as HTMLButtonElement).disabled).toBe(true);
    expect(wrapper.text()).toContain('open a connection first');
  });

  it('disables running while a statement is in flight', () => {
    const wrapper = tracked(mountEditor({ busy: true }));
    expect((wrapper.find('[data-run]').element as HTMLButtonElement).disabled).toBe(true);
    expect(wrapper.find('[data-run]').text()).toContain('Running');
  });

  it('leaves Cancel inert until something is actually on the server', async () => {
    const wrapper = tracked(mountEditor());
    const cancel = wrapper.find('[data-cancel]').element as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);

    await wrapper.setProps({ busy: true, runningLabel: 'select pg_sleep(60)' });
    expect(cancel.disabled).toBe(false);
    expect(wrapper.find('[data-cancel]').text()).toContain('select pg_sleep(60)');

    await wrapper.find('[data-cancel]').trigger('click');
    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });

  it('does not emit run when disabled, even from a keyboard shortcut', async () => {
    const wrapper = tracked(mountEditor({ connectionId: null }));
    await type(wrapper, 'select 1');
    await press(wrapper, 'Enter', { meta: true });
    expect(wrapper.emitted('run')).toBeUndefined();
  });
});

describe('scroll sync', () => {
  it('copies the textarea offset to the highlight layer and the gutter', async () => {
    const wrapper = tracked(mountEditor());
    await type(wrapper, Array.from({ length: 40 }, (_, i) => `select ${i};`).join('\n'));

    const element = area(wrapper);
    element.scrollTop = 90;
    element.scrollLeft = 12;
    element.dispatchEvent(new Event('scroll'));
    await wrapper.vm.$nextTick();

    const highlight = wrapper.find('[data-highlight]').element as HTMLElement;
    const gutter = wrapper.find('.gutter').element as HTMLElement;
    expect(highlight.scrollTop).toBe(90);
    expect(highlight.scrollLeft).toBe(12);
    expect(gutter.scrollTop).toBe(90);
  });
});

describe('focus', () => {
  it('does not intercept Tab, so the pane cannot become a keyboard trap', async () => {
    // Inserting spaces on Tab is what a code editor does, and trapping focus is an
    // accessibility failure. Native movement wins; the test pins the decision.
    const wrapper = tracked(mountEditor());
    await type(wrapper, 'select 1');
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    area(wrapper).dispatchEvent(event);
    await wrapper.vm.$nextTick();
    expect(event.defaultPrevented).toBe(false);
  });

  it('exposes setText for callers that load a script into the editor', async () => {
    const wrapper = tracked(mountEditor());
    const vm = wrapper.vm as unknown as { setText: (text: string) => void };
    vm.setText('select * from fixtures.big');
    await wrapper.vm.$nextTick();
    expect(area(wrapper).value).toBe('select * from fixtures.big');
    expect(wrapper.find('[data-highlight]').element.textContent).toBe('select * from fixtures.big');
  });
});
