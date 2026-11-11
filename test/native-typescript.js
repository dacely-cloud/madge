/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const madge = require('../lib/api');
const ModuleDependencies = require('../lib/module-dependencies');

describe('Native TypeScript graph', () => {
	let directory;
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), 'madge-native-'));
	});
	afterEach(async () => {
		await fs.rm(directory, {recursive: true, force: true});
	});

	it('includes type imports, import types, exports, CommonJS and literal dynamic imports', () => {
		const source = `
			import type { A } from './a.js';
			export type { B } from './b.js';
			type C = import('./c.js').C;
			import D = require('./d.cjs');
			const e = require('./e.js');
			const f = import('./f.js');
			const computed = import(variable);
		`;
		assert.deepEqual(ModuleDependencies.read('input.ts', source).map((edge) => edge.specifier), [
			'./a.js', './b.js', './c.js', './d.cjs', './e.js', './f.js'
		]);
	});

	it('resolves inherited paths, emitted extensions and erased-type cycles with TypeScript 7 installed', async () => {
		await fs.mkdir(path.join(directory, 'src'));
		await fs.writeFile(path.join(directory, 'base.json'), JSON.stringify({compilerOptions: {paths: {'@local/*': ['./src/*']}}}));
		await fs.writeFile(path.join(directory, 'tsconfig.json'), '{"extends":"./base.json", "compilerOptions":{"erasableSyntaxOnly":true}}');
		await fs.writeFile(path.join(directory, 'src/a.ts'), 'import type {B} from "@local/b.js"; export interface A {b: B}');
		await fs.writeFile(path.join(directory, 'src/b.ts'), 'export type B = import("./a.js").A;');
		const result = await madge(path.join(directory, 'src'), {fileExtensions: ['ts'], strict: true, tsConfig: path.join(directory, 'tsconfig.json')});
		assert.deepEqual(result.circular(), [['a.ts', 'b.ts']]);
		assert.deepEqual(result.warnings(), {skipped: []});
	});

	it('fails the real circular CLI in JSON mode and passes after the cycle is removed', async () => {
		await fs.writeFile(path.join(directory, 'a.ts'), 'import type {B} from "./b.js"; export interface A {b:B}');
		await fs.writeFile(path.join(directory, 'b.ts'), 'import type {A} from "./a.js"; export interface B {a:A}');
		const args = [path.join(__dirname, '../bin/cli.js'), '--circular', '--json', '--strict', '--extensions', 'ts', directory];
		const failed = spawnSync(process.execPath, args, {encoding: 'utf8'});
		assert.equal(failed.status, 1, failed.stdout + failed.stderr);
		assert.deepEqual(JSON.parse(failed.stdout), [['a.ts', 'b.ts']]);
		await fs.writeFile(path.join(directory, 'b.ts'), 'export interface B {value:string}');
		const passed = spawnSync(process.execPath, args, {encoding: 'utf8'});
		assert.equal(passed.status, 0, passed.stdout + passed.stderr);
	});

	it('rejects malformed source and unresolved local edges in strict mode', async () => {
		const filename = path.join(directory, 'input.ts');
		await fs.writeFile(filename, 'export const broken: =');
		await assert.rejects(madge(filename, {strict: true}), /Cannot analyze/);
		await fs.writeFile(filename, 'import "./missing.js"');
		await assert.rejects(madge(filename, {strict: true}), /Cannot resolve/);
		await fs.writeFile(filename, 'import "@local/missing"');
		await assert.rejects(madge(filename, {strict: true}), /Cannot resolve/);
	});

	it('resolves packages exposing only TypeScript declarations for type-only imports', async () => {
		const dependency = path.join(directory, 'node_modules/types-only');
		await fs.mkdir(dependency, {recursive: true});
		await fs.writeFile(path.join(dependency, 'package.json'), '{"name":"types-only","exports":{"./options":{"types":"./options.d.ts"}}}');
		await fs.writeFile(path.join(dependency, 'options.d.ts'), 'export interface Options {enabled:boolean}');
		const filename = path.join(directory, 'input.ts');
		await fs.writeFile(filename, 'import type {Options} from "types-only/options"; export type O=Options;');
		const result = await madge(filename, {strict: true});
		assert.deepEqual(result.warnings(), {skipped: []});
		await fs.writeFile(filename, 'import {type Options} from "types-only/options"; export type O=Options;');
		assert.deepEqual((await madge(filename, {strict: true})).warnings(), {skipped: []});
	});

	it('discovers owned source without scanning ignored builds or requiring a Git checkout', async () => {
		await fs.mkdir(path.join(directory, 'src'));
		await fs.mkdir(path.join(directory, 'build'));
		await fs.writeFile(path.join(directory, '.gitignore'), 'build/\n*.generated.ts\n');
		await fs.writeFile(path.join(directory, 'src/.gitignore'), '!keep.generated.ts\n');
		await fs.writeFile(path.join(directory, 'src/keep.generated.ts'), 'export const value = 1;');
		await fs.writeFile(path.join(directory, 'src/skip.generated.ts'), 'this is not source');
		await fs.writeFile(path.join(directory, 'build/broken.ts'), 'this is not source');
		const result = await madge(directory, {fileExtensions: ['ts'], strict: true, respectGitIgnore: true});
		assert.deepEqual(result.obj(), {'src/keep.generated.ts': []});
	});

	it('supports explicit virtual external modules while still rejecting other missing imports', async () => {
		const filename = path.join(directory, 'input.ts');
		await fs.writeFile(filename, 'import "virtual:routes"');
		const result = await madge(filename, {strict: true, externalModules: ['virtual:routes']});
		assert.deepEqual(result.warnings(), {skipped: []});
		await fs.writeFile(filename, 'import "virtual:other"');
		await assert.rejects(madge(filename, {strict: true, externalModules: ['virtual:routes']}), /Cannot resolve/);
	});
});
