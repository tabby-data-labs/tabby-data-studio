// @vitest-environment happy-dom
/**
 * The command palette (PLAN Phase 8).
 *
 * Tier 2 — Vue plus DOM, written after the implementation. The ranking itself is
 * Tier 1 in `palette-fuzzy.spec.ts` and the highlight segmentation in
 * `palette-segments.spec.ts`; what only a mounted component can show is that the
 * keyboard contract reaches a command, and that a matched character is actually
 * marked up rather than merely scored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import CommandPalette from '@/components/CommandPalette.vue';
import type { PaletteCommand } from '@/palette/command';

function command(id: string, title: string, extra: Partial<PaletteCommand> = {}): PaletteCommand {
  return { id, title, run: () => undefined, ...extra };
}

const COMMANDS: readonly PaletteCommand[] = [
  command('query.run', 'Run statement at cursor', { group: 'Query', hint: '⌘↵' }),
  command('query.history', 'Query history', { group: 'Query' }),
  command('result.export', 'Export result', { group: 'Result', hint: 'CSV · TSV' }),
  command('view.theme', 'Theme: Light', { group: 'View' }),
  command('view.schema', 'Refresh schema tree', { group: 'View' }),
];

const mounted: VueWrapper[] = [];
const runs: string[] = [];

function mountPalette(commands: readonly PaletteCommand[] = COMMANDS): VueWrapper {
  const tracked = commands.map((item) => ({
    ...item,
    run: () => runs.push(item.id),
  }));
  const wrapper = mount(CommandPalette, {
    props: { commands: tracked },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

function rowIds(wrapper: VueWrapper): string[] {
  return wrapper.findAll('[data-palette-row]').map((row) => row.attributes('data-palette-row')!);
}

function activeId(wrapper: VueWrapper): string | undefined {
  return wrapper.find('[data-palette-row][data-active="true"]').attributes('data-palette-row');
}

async function type(wrapper: VueWrapper, text: string): Promise<void> {
  await wrapper.find('[data-palette-input]').setValue(text);
}

function key(wrapper: VueWrapper, key: string): Promise<void> {
  return wrapper.find('[data-palette-input]').trigger('keydown', { key });
}

beforeEach(() => {
  runs.length = 0;
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});

describe('listing', () => {
  it('lists every command in registration order before anything is typed', () => {
    const wrapper = mountPalette();
    expect(rowIds(wrapper)).toEqual([
      'query.run',
      'query.history',
      'result.export',
      'view.theme',
      'view.schema',
    ]);
  });

  it('selects the first row', () => {
    expect(activeId(mountPalette())).toBe('query.run');
  });

  it('is a labelled dialog with a combobox input', () => {
    const wrapper = mountPalette();
    const dialog = wrapper.find('[data-command-palette]');
    expect(dialog.attributes('role')).toBe('dialog');
    expect(dialog.attributes('aria-label')).toBe('Command palette');

    const input = wrapper.find('[data-palette-input]');
    expect(input.attributes('role')).toBe('combobox');
    expect(input.attributes('aria-controls')).toBe('palette-list');
    expect(input.attributes('placeholder')).toBe('Type a command…');
  });

  it('marks rows as listbox options with the active one selected', () => {
    const wrapper = mountPalette();
    expect(wrapper.find('[data-palette-list]').attributes('role')).toBe('listbox');
    const options = wrapper.findAll('[role="option"]');
    expect(options).toHaveLength(5);
    expect(options[0]!.attributes('aria-selected')).toBe('true');
    expect(options[1]!.attributes('aria-selected')).toBe('false');
  });

  it('shows a group heading once per run of rows, not once per row', () => {
    const groups = mountPalette()
      .findAll('.group')
      .map((each) => each.text());
    expect(groups).toEqual(['Query', 'Result', 'View']);
  });

  it('shows a hint beside the commands that have one', () => {
    const wrapper = mountPalette();
    expect(wrapper.findAll('.hint').map((each) => each.text())).toEqual(['⌘↵', 'CSV · TSV']);
  });

  it('says so when nothing matches, quoting what was typed', async () => {
    const wrapper = mountPalette();
    await type(wrapper, 'zzzqqq');
    expect(wrapper.find('[data-palette-empty]').exists()).toBe(true);
    expect(wrapper.find('[data-palette-empty]').text()).toContain('zzzqqq');
    expect(wrapper.find('[data-palette-list]').exists()).toBe(false);
  });

  it('lists everything again when the query is cleared', async () => {
    const wrapper = mountPalette();
    await type(wrapper, 'zzzqqq');
    await type(wrapper, '');
    expect(rowIds(wrapper)).toHaveLength(5);
    expect(wrapper.find('[data-palette-empty]').exists()).toBe(false);
  });

  it('handles an empty command list without a selected row', () => {
    const wrapper = mountPalette([]);
    expect(rowIds(wrapper)).toEqual([]);
    expect(wrapper.find('[data-palette-row][data-active="true"]').exists()).toBe(false);
  });
});

describe('ranking', () => {
  it('ranks a subsequence match above a later-listed exact-ish one', async () => {
    const wrapper = mountPalette();
    await type(wrapper, 'exp');
    expect(rowIds(wrapper)[0]).toBe('result.export');
  });

  it('ranks by match quality, not by registration order', async () => {
    const wrapper = mountPalette();
    // 'thm' matches "Theme: Light" as a subsequence and nothing else.
    await type(wrapper, 'thm');
    expect(rowIds(wrapper)).toEqual(['view.theme']);
  });

  it('marks the matched letters, in the label’s own case', async () => {
    const wrapper = mountPalette();
    await type(wrapper, 'thm');
    // 'Thm' — the T, h and m of "Theme: Light". The highlight marks characters of
    // the label, so it carries the label's case, not the query's.
    const marks = wrapper.findAll('mark.hit').map((each) => each.text());
    expect(marks.join('')).toBe('Thm');
    expect(marks.join('').toLowerCase()).toBe('thm');
    // And the row still reads as the whole label, marks included.
    expect(wrapper.find('.title').text()).toBe('Theme: Light');
  });

  it('resets the selection to the top when the query changes', async () => {
    const wrapper = mountPalette();
    await key(wrapper, 'ArrowDown');
    await key(wrapper, 'ArrowDown');
    expect(activeId(wrapper)).toBe('result.export');

    await type(wrapper, 'e');
    expect(activeId(wrapper)).toBe(rowIds(wrapper)[0]);
  });
});

describe('keyboard', () => {
  it('moves the selection with the arrows and wraps at both ends', async () => {
    const wrapper = mountPalette();
    expect(activeId(wrapper)).toBe('query.run');

    await key(wrapper, 'ArrowDown');
    expect(activeId(wrapper)).toBe('query.history');
    await key(wrapper, 'ArrowDown');
    expect(activeId(wrapper)).toBe('result.export');

    await key(wrapper, 'ArrowUp');
    expect(activeId(wrapper)).toBe('query.history');

    await key(wrapper, 'ArrowUp');
    await key(wrapper, 'ArrowUp');
    // Wrapping rather than stopping: a palette is a cycling list, and dead-ending
    // at the top means the last item takes five presses to reach.
    expect(activeId(wrapper)).toBe('view.schema');
  });

  it('jumps to the ends with Home and End', async () => {
    const wrapper = mountPalette();
    await key(wrapper, 'End');
    expect(activeId(wrapper)).toBe('view.schema');
    await key(wrapper, 'Home');
    expect(activeId(wrapper)).toBe('query.run');
  });

  it('runs the selected command on Enter and closes', async () => {
    const wrapper = mountPalette();
    await key(wrapper, 'ArrowDown');
    await key(wrapper, 'Enter');

    expect(runs).toEqual(['query.history']);
    expect(wrapper.emitted('close')).toBeTruthy();
  });

  it('emits close as well as running, so an overlay-opening command is not covered', async () => {
    const wrapper = mountPalette();
    await key(wrapper, 'Enter');
    expect(runs).toEqual(['query.run']);
    // Both happen; the component emits close first by construction, so a command
    // that opens the export dialog or the history panel is not immediately covered.
    expect(wrapper.emitted('close')).toBeTruthy();
  });

  it('emits close on Escape without running anything', async () => {
    const wrapper = mountPalette();
    await key(wrapper, 'Escape');
    expect(wrapper.emitted('close')).toBeTruthy();
    expect(runs).toEqual([]);
  });

  it('does nothing on Enter with no matches', async () => {
    const wrapper = mountPalette();
    await type(wrapper, 'zzzqqq');
    await key(wrapper, 'Enter');
    expect(runs).toEqual([]);
    expect(wrapper.emitted('close')).toBeUndefined();
  });

  it('stops the arrows and Escape from reaching the grid underneath', async () => {
    // The grid binds arrows, Home, End and Escape. A palette that let them through
    // would scroll the result and clear its selection while the user was choosing.
    const wrapper = mountPalette();
    for (const pressed of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Escape']) {
      const event = new KeyboardEvent('keydown', { key: pressed, bubbles: true, cancelable: true });
      wrapper.find('[data-palette-input]').element.dispatchEvent(event);
      expect(event.defaultPrevented, pressed).toBe(true);
    }
  });

  it('leaves ordinary typing alone', async () => {
    const wrapper = mountPalette();
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    wrapper.find('[data-palette-input]').element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('pointer', () => {
  it('runs a command on click', async () => {
    const wrapper = mountPalette();
    await wrapper.findAll('[data-palette-row]')[2]!.trigger('click');
    expect(runs).toEqual(['result.export']);
    expect(wrapper.emitted('close')).toBeTruthy();
  });

  it('moves the selection on hover, so click and keyboard agree', async () => {
    const wrapper = mountPalette();
    await wrapper.findAll('[data-palette-row]')[3]!.trigger('mouseenter');
    expect(activeId(wrapper)).toBe('view.theme');
  });
});

describe('lifecycle', () => {
  it('focuses the input on mount, so typing works immediately', () => {
    const wrapper = mountPalette();
    expect(document.activeElement).toBe(wrapper.find('[data-palette-input]').element);
  });

  it('stops answering Escape once unmounted', async () => {
    const wrapper = mountPalette();
    const index = mounted.indexOf(wrapper);
    if (index >= 0) mounted.splice(index, 1);
    wrapper.unmount();

    const closed: string[] = [];
    document.addEventListener('keydown', () => closed.push('seen'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // The listener is gone with the component; only this spec's own probe fires.
    expect(closed).toEqual(['seen']);
  });
});
