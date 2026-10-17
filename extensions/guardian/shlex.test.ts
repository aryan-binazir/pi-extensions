// Ported from the shlex crate 1.3.0 src/{lib,bytes}.rs tests (MIT OR Apache-2.0, (c) 2015 Nicholas Allegra), used by openai/codex @ ce0323f.
import assert from 'node:assert/strict';
import test from 'node:test';
import { shlexSplit, shlexTryJoin, shlexTryQuote } from './shlex.ts';

test('split', () => {
  for (const [input, output] of [
    ['foo$baz', ['foo$baz']],
    ['foo baz', ['foo', 'baz']],
    ['foo"bar"baz', ['foobarbaz']],
    ['foo "bar"baz', ['foo', 'barbaz']],
    ['   foo \nbar', ['foo', 'bar']],
    ['foo\\\nbar', ['foobar']],
    ['"foo\\\nbar"', ['foobar']],
    ["'baz\\$b'", ['baz\\$b']],
    ["'baz\\''", undefined],
    ['\\', undefined],
    ['"\\', undefined],
    ["'\\", undefined],
    ['"', undefined],
    ["'", undefined],
    ['foo #bar\nbaz', ['foo', 'baz']],
    ['foo #bar', ['foo']],
    ['foo#bar', ['foo#bar']],
    ['foo"#bar', undefined],
    ["'\\n'", ['\\n']],
    ["'\\\\n'", ['\\\\n']],
  ] as const) {
    assert.deepEqual(shlexSplit(input), output, JSON.stringify(input));
  }
});

test('quote', () => {
  const table = `
    <>                => <''>
    <foobar>          => <foobar>
    <foo bar>         => <'foo bar'>
    <"foo bar'">      => <"\\"foo bar'\\"">
    <'foo bar'>       => <"'foo bar'">
    <">               => <'"'>
    <"'>              => <"\\"'">
    <hello!world>     => <'hello!world'>
    <'hello!world>    => <"'hello"'!world'>
    <'hello!>         => <"'hello"'!'>
    <hello ^ world>   => <'hello ''^ world'>
    <hello^>          => <hello'^'>
    <!world'>         => <'!world'"'">
    <{a, b}>          => <'{a, b}'>
    <NL>              => <'NL'>
    <^>               => <'^'>
    <foo^bar>         => <foo'^bar'>
    <NLx^>            => <'NLx''^'>
    <NL^x>            => <'NL''^x'>
    <NL ^x>           => <'NL ''^x'>
    <{a,b}>           => <'{a,b}'>
    <a,b>             => <'a,b'>
    <a..b             => <a..b>
    <'$>              => <"'"'$'>
    <"^>              => <'"''^'>
  `;
  for (const line of table.trim().split('\n')) {
    const [input, expected] = line.replaceAll('NL', '\n').split('=>').map(part => part.trim().replace(/^</, '').replace(/>$/, ''));
    assert.equal(shlexTryQuote(input), expected, JSON.stringify(input));
  }
  assert.equal(shlexTryQuote('é'), "'é'");
});

test('join', () => {
  assert.equal(shlexTryJoin([]), '');
  assert.equal(shlexTryJoin(['']), "''");
  assert.equal(shlexTryJoin(['a', 'b']), 'a b');
  assert.equal(shlexTryJoin(['foo bar', 'baz']), "'foo bar' baz");
});

test('fallible', () => {
  assert.equal(shlexTryJoin(['\0']), undefined);
  assert.equal(shlexTryQuote('\0'), undefined);
});
