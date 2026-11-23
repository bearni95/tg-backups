// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseDotenv } from '../../src/utils/env/parseDotenv';
import {
	asObject,
	parseJson,
	rawInteger,
	stringifyCanonical
} from '../../src/utils/json/losslessJson';

describe('losslessJson', () => {
	it('never rounds 64-bit integers', () => {
		const text = '{"auth":-8123456789012345678,"big":9223372036854775807,"n":3}';
		expect(JSON.stringify(parseJson(text))).toBe(text);
		expect(JSON.stringify({ a: rawInteger('-8123456789012345678') })).toBe(
			'{"a":-8123456789012345678}'
		);
		expect(rawInteger('42')).toBe(42);
	});

	it('writes compact JSON with keys sorted by code point', () => {
		expect(stringifyCanonical({ b: 1, a: { d: [1, { z: 1, y: null }], c: 'x' } })).toBe(
			'{"a":{"c":"x","d":[1,{"y":null,"z":1}]},"b":1}'
		);
		expect(stringifyCanonical({ '🎉': 1, '￿': 2 })).toBe('{"￿":2,"🎉":1}');
		expect(stringifyCanonical({ '10': 1, '2': 2 })).toBe('{"10":1,"2":2}');
		expect(stringifyCanonical(parseJson('{"n":8123456789012345678}'))).toBe(
			'{"n":8123456789012345678}'
		);
	});

	it('only treats plain objects as objects', () => {
		expect(asObject({ a: 1 })).toEqual({ a: 1 });
		for (const value of [null, [], 'x', 1, rawInteger('9223372036854775807')]) {
			expect(asObject(value)).toBeNull();
		}
	});
});

describe('parseDotenv', () => {
	const parse = (text: string, env = {}) => Object.fromEntries(parseDotenv(text, env).values);

	it('reads the example file format', () => {
		expect(parse('# comment\n\nTELEGRAM_API_ID=123\nTELEGRAM_API_HASH=\n')).toEqual({
			TELEGRAM_API_ID: '123',
			TELEGRAM_API_HASH: ''
		});
	});

	it('only treats # after whitespace as a comment', () => {
		expect(parse('A=/data/#1\nB=x # note\nC=# empty')).toEqual({ A: '/data/#1', B: 'x', C: '' });
	});

	it('substitutes variables outside single quotes', () => {
		const env = { HOME: '/home/me' };
		expect(parse('A=$HOME/tgb\nB=${HOME}/b\nC=\'$HOME\'\nD="$HOME"\nE=\\$HOME', env)).toEqual({
			A: '/home/me/tgb',
			B: '/home/me/b',
			C: '$HOME',
			D: '/home/me',
			E: '$HOME'
		});
		expect(parse('ROOT=/srv\nDIR=$ROOT/tgb')).toEqual({ ROOT: '/srv', DIR: '/srv/tgb' });
	});

	it('handles quotes, export, CRLF, a BOM and multi-line values', () => {
		expect(parse('﻿export A="a b"\r\nB = \'c d\'\r\nC="one\ntwo"\nexport=yes')).toEqual({
			A: 'a b',
			B: 'c d',
			C: 'one\ntwo',
			export: 'yes'
		});
	});

	it('keeps the first of a repeated key', () => {
		expect(parse('A=first\nA=second')).toEqual({ A: 'first' });
	});

	it('stops at a bad line without echoing it', () => {
		const { values, error } = parseDotenv('A=1\nsecret value here\nB=2');
		expect(Object.fromEntries(values)).toEqual({ A: '1' });
		expect(error).toBe('line 2 is not KEY=value');
	});
});
