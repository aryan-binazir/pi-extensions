import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalLabel, terminalText } from '../extensions/terminal-text.ts';

test('terminal text policies remove terminal sequences without changing printable text', () => {
  for (const [name, input, label, text] of [
    ['empty', '', '', ''],
    ['joiners', 'a\u200c\u200db', 'a b', 'a  b'],
    ['ESC DCS', 'a\x1bPbad payload\x1b\\b', 'ab', 'ab'],
    ['C1 DCS', 'a\x90bad payload\x9cb', 'ab', 'ab'],
    ['DCS embedded BEL', 'a\x1bPbad\x07payload\x1b\\b', 'ab', 'ab'],
    ['SOS embedded BEL', 'a\x1bXbad\x07payload\x1b\\b', 'ab', 'ab'],
    ['PM embedded BEL', 'a\x1b^bad\x07payload\x1b\\b', 'ab', 'ab'],
    ['APC embedded BEL', 'a\x1b_bad\x07payload\x1b\\b', 'ab', 'ab'],
    ['C1 DCS embedded BEL', 'a\x90bad\x07payload\x9cb', 'ab', 'ab'],
    ['C1 SOS embedded BEL', 'a\x98bad\x07payload\x9cb', 'ab', 'ab'],
    ['C1 PM embedded BEL', 'a\x9ebad\x07payload\x9cb', 'ab', 'ab'],
    ['C1 APC embedded BEL', 'a\x9fbad\x07payload\x9cb', 'ab', 'ab'],
    ['reset', 'a\x1bcb', 'ab', 'ab'],
    ['ASCII', 'plain text', 'plain text', 'plain text'],
    ['Unicode', '模型 😀 café', '模型 😀 café', '模型 😀 café'],
    ['bidi', 'a\u202eb', 'a b', 'a b'],
    ['zero width', 'a\u200bb', 'a b', 'a b'],
    ['BOM', 'a\ufeffb', 'a b', 'a b'],
    ['CR', 'a\rb', 'a b', 'a\nb'],
    ['CRLF', 'a\r\nb', 'a b', 'a\nb'],
    ['tab', 'a\tb', 'a b', 'a    b'],
    ['tab indentation', '- parent\n\t- child', '- parent - child', '- parent\n    - child'],
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
    ['CSI mixed parameters', 'a\x1b[;?31mb', 'ab', 'ab'],
    ['unterminated CSI', 'a\x1b[;?', 'a', 'a'],
    ['long CSI parameter run', 'a\x1b[' + ';?'.repeat(15999), 'a', 'a'],
    ['unterminated C1 CSI', 'a\x9b;?', 'a', 'a'],
    ['ESC character set', 'a\x1b(Bb', 'ab', 'ab'],
  ]) {
    assert.equal(terminalLabel(input), label, `${name}: label`);
    assert.equal(terminalText(input), text, `${name}: text`);
    assert.doesNotMatch(terminalLabel(input), /[\p{Cc}\p{Cf}\p{Cs}]/u, `${name}: safe label`);
    assert.doesNotMatch(terminalText(input).replaceAll('\n', ''), /[\p{Cc}\p{Cf}\p{Cs}]/u, `${name}: safe text`);
  }
});
