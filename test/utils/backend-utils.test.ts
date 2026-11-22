// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseDotenv } from '../../src/utils/env/parseDotenv';
import { parseByteRange } from '../../src/utils/http/byteRange';
import { attachmentDisposition, sanitiseFilename } from '../../src/utils/http/contentDisposition';
import { hasLocalHeaders, isLoopbackAddress } from '../../src/utils/http/loopback';
import {
	asObject,
	parseJson,
	rawInteger,
	stringifyCanonical
} from '../../src/utils/json/losslessJson';

describe('parseByteRange', () => {
	it.each([
		['bytes=0-9', 0, 9],
		['bytes=10-', 10, 99],
		['bytes=-20', 80, 99],
		['bytes=-500', 0, 99],
		['bytes=90-500', 90, 99],
		['bytes=0-1,10-20', 0, 1]
	])('%s', (header, start, end) => {
		expect(parseByteRange(header, 100)).toEqual({ start, end });
	});

	it.each([
		'bytes=200-',
		'bytes=100-',
		'entries=0-9',
		'bytes=5-2',
		'bytes=-0',
		'bytes=a-b',
		'bytes=5'
	])('rejects %s', (header) => {
		expect(parseByteRange(header, 100)).toBeNull();
	});

	it('has nothing to give from an empty file', () => {
		expect(parseByteRange('bytes=-5', 0)).toBeNull();
		expect(parseByteRange('bytes=0-', 0)).toBeNull();
	});
});

describe('contentDisposition', () => {
	it('strips quotes, backslashes and line breaks', () => {
		expect(sanitiseFilename('abc"def')).toBe('abc_def');
		expect(sanitiseFilename('a\\b')).toBe('a_b');
		expect(sanitiseFilename('a\rb\nc')).toBe('a_b_c');
		expect(sanitiseFilename('normal name.zip')).toBe('normal name.zip');
	});

	it('is always a valid header', () => {
		expect(attachmentDisposition('db.zip')).toBe('attachment; filename="db.zip"');
		expect(attachmentDisposition('a\u0001b.zip')).toBe('attachment');
		for (const name of ['còpia.zip', '备份.zip', '🎉.zip', "it's (1).zip"]) {
			const value = attachmentDisposition(name);
			expect(() => new Headers({ 'content-disposition': value })).not.toThrow();
		}
		expect(attachmentDisposition('còpia.zip')).toContain("filename*=UTF-8''c%C3%B2pia.zip");
	});
});

describe('loopback', () => {
	it.each([
		['localhost:5173', null],
		['127.0.0.1:9811', 'http://localhost:5173'],
		['[::1]:9811', null],
		['localhost', undefined]
	])('accepts %s from %s', (host, origin) => {
		expect(hasLocalHeaders(host, origin)).toBe(true);
	});

	it.each([
		['evil.example:9811', null],
		['localhost.evil.example', null],
		['localhost:9811', 'https://evil.example'],
		['localhost:9811', 'http://localhost.evil.example'],
		['localhost:9811', 'null'],
		['localhost:9811', ''],
		['localhost@evil.example', null],
		['', null],
		[null, null]
	])('rejects %s from %s', (host, origin) => {
		expect(hasLocalHeaders(host, origin)).toBe(false);
	});

	it('knows loopback addresses', () => {
		for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
			expect(isLoopbackAddress(address)).toBe(true);
		}
		for (const address of ['10.0.0.2', '::ffff:10.0.0.2', '0.0.0.0', '', undefined]) {
			expect(isLoopbackAddress(address)).toBe(false);
		}
	});
});

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
