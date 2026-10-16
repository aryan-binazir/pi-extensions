import assert from 'node:assert/strict';
import test from 'node:test';
import { CustomEditor } from '@earendil-works/pi-coding-agent';
import { attachViMode } from './editor.ts';
import { editor, keys } from './test-support.ts';

class SuggestionEditor extends CustomEditor {
  suggestion = '';
  inputs: string[] = [];
  clearCount = 0;
  override handleInput(data: string): void {
    this.inputs.push(data);
    if (data === '\t' && this.suggestion) {
      this.insertTextAtCursor(this.suggestion);
      this.forceClearGhost();
      return;
    }
    if (data === '\x1b[C' && this.suggestion) {
      this.setText(this.getText().replace(/\w+$/, this.suggestion));
      this.forceClearGhost();
      return;
    }
    super.handleInput(data);
  }
  forceClearGhost(): void {
    this.suggestion = '';
    this.clearCount++;
  }
  override render(width: number): string[] {
    return [...super.render(width), this.suggestion];
  }
}

test('Vi composes with a custom editor without replacing its instance or insert handler', () => {
  const e = editor(SuggestionEditor);
  const dispose = attachViMode(e);
  keys(e, 'hello');
  e.suggestion = ' world';
  e.handleInput('\t');
  assert.equal(e.getText(), 'hello world');
  assert.ok(e instanceof SuggestionEditor);
  assert.ok(e.inputs.includes('\t'));
  e.handleInput('\x1b');
  keys(e, 'u');
  assert.equal(e.getText(), 'hello');
  keys(e, 'u');
  assert.equal(e.getText(), '');
  dispose();
});

test('custom token replacements retain Vi undo, redo, and existing paste payloads', () => {
  const e = editor(SuggestionEditor);
  const dispose = attachViMode(e);
  const payload = 'synthetic paste\n'.repeat(20);
  e.handleInput('\x1b[200~' + payload + '\x1b[201~');
  keys(e, ' abc');
  const before = e.getText();
  e.suggestion = 'abcdef';
  e.handleInput('\x1b[C');
  assert.equal(e.getExpandedText(), payload + ' abcdef');
  e.handleInput('\x1b');
  keys(e, 'u');
  assert.equal(e.getText(), before);
  assert.equal(e.getExpandedText(), payload + ' abc');
  e.handleInput('\x12');
  assert.equal(e.getExpandedText(), payload + ' abcdef');
  dispose();
});

test('independent Vi module copies attach once to the same editor', async () => {
  const secondModule = './editor.ts?second-copy';
  const second = await import(secondModule);
  const e = editor(CustomEditor);
  const dispose = attachViMode(e);
  assert.equal(second.attachViMode(e), dispose);
  keys(e, 'hello\x1b0x');
  assert.equal(e.getText(), 'ello');
  keys(e, 'u');
  assert.equal(e.getText(), 'hello');
  dispose();
});

test('Escape enters normal mode and clears custom suggestions before Vi motions', () => {
  const e = editor(SuggestionEditor);
  const dispose = attachViMode(e);
  keys(e, 'alpha beta');
  e.suggestion = ' gamma';
  e.handleInput('\x1b');
  assert.equal(e.suggestion, '');
  const count = e.inputs.length;
  keys(e, '0dw');
  assert.equal(e.getText(), 'beta');
  assert.equal(e.inputs.length, count);
  e.suggestion = ' late response';
  const screen = e.render(80).join('\n');
  assert.doesNotMatch(screen, /late response/);
  assert.match(screen, /NORMAL/);
  dispose();
});

test('asynchronous custom-editor invalidation requests a terminal repaint', () => {
  const e = editor(SuggestionEditor);
  const tui = (e as any).tui;
  let repaints = 0;
  tui.requestRender = () => { repaints++; };
  const dispose = attachViMode(e);
  repaints = 0;
  e.suggestion = 'synthetic asynchronous completion';
  e.invalidate();
  assert.equal(repaints, 1);
  assert.match(e.render(80).join('\n'), /synthetic asynchronous completion/);
  dispose();
  repaints = 0;
  e.invalidate();
  assert.equal(repaints, 0, 'retired editors do not schedule terminal work');
});

test('composed editors preserve collapsed paste payloads through Vi undo and submission', () => {
  const e = editor(SuggestionEditor);
  const dispose = attachViMode(e);
  const payload = 'synthetic paste 😀\t\n'.repeat(100);
  e.handleInput('\x1b[200~' + payload + '\x1b[201~');
  assert.match(e.getText(), /\[paste #/);
  assert.equal(e.getExpandedText(), payload);
  e.handleInput('\x1b');
  keys(e, 'ggdd');
  assert.equal(e.getText(), '');
  keys(e, 'u');
  assert.equal(e.getExpandedText(), payload);
  let submitted = '';
  e.onSubmit = text => { submitted = text; };
  e.handleInput('\r');
  assert.equal(submitted, payload.trim());
  dispose();
});
