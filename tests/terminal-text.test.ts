import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalLabel, terminalText } from '../extensions/terminal-text.ts';

test('terminal text policies remove terminal sequences without changing printable text', () => {
  for (const [name, input, label, text] of [
    ['empty', '', '', ''],
    ['joiners', 'a\u200c\u200db', 'a b', 'a  b'],
    ['ESC DCS', 'a\x1bPbad payload\x1b\\b', 'ab', 'ab'],
    ['C1 DCS', 'a\x90bad payload\x9cb', 'ab', 'ab'],
    ['reset', 'a\x1bcb', 'ab', 'ab'],
    ['ASCII', 'plain text', 'plain text', 'plain text'],
    ['Unicode', '模型 😀 café', '模型 😀 café', '模型 😀 café'],
    ['bidi', 'a\u202eb', 'a b', 'a b'],
    ['zero width', 'a\u200bb', 'a b', 'a b'],
    ['BOM', 'a\ufeffb', 'a b', 'a b'],
    ['CR', 'a\rb', 'a b', 'a\nb'],
    ['CRLF', 'a\r\nb', 'a b', 'a\nb'],
    ['tab', 'a\tb', 'a b', 'a b'],
    ['LF', 'a\nb', 'a b', 'a\nb'],
    ['high surrogate', 'a\ud800b', 'a\ufffdb', 'a\ufffdb'],
    ['low surrogate', 'a\udc00b', 'a\ufffdb', 'a\ufffdb'],
    ['C0 and C1', 'a\x00\x07\x7f\x85b', 'a b', 'a    b'],
    ['spacing', '  a  b \n\n    c  ', 'a b c', '  a  b \n\n    c  '],
    ['OSC BEL', 'a\x1b]0;bad title\x07b', 'ab', 'ab'],
    ['OSC ST', 'a\x1b]0;bad title\x1b\\b', 'ab', 'ab'],
    ['C1 CSI', 'a\x9b31mb\x9b0m', 'ab', 'ab'],
    ['C1 OSC BEL', 'a\x9d0;bad title\x07b', 'ab', 'ab'],
    ['C1 OSC ST', 'a\x9d0;bad title\x9cb', 'ab', 'ab'],
    ['unterminated OSC', 'a\x1b]0;bad title', 'a', 'a'],
    ['unterminated C1 OSC', 'a\x9d0;bad title', 'a', 'a'],
    ['ESC CSI', 'a\x1b[31mb\x1b[0m', 'ab', 'ab'],
  ]) {
    assert.equal(terminalLabel(input), label, `${name}: label`);
    assert.equal(terminalText(input), text, `${name}: text`);
    assert.doesNotMatch(terminalLabel(input), /[\p{Cc}\p{Cf}\p{Cs}]/u, `${name}: safe label`);
    assert.doesNotMatch(terminalText(input).replaceAll('\n', ''), /[\p{Cc}\p{Cf}\p{Cs}]/u, `${name}: safe text`);
  }
});
