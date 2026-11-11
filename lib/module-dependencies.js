'use strict';

const path = require('node:path');
const {parseSync, visitorKeys} = require('oxc-parser');
const babel = require('@babel/parser');

/** Collect static edges without depending on the removed TypeScript compiler API. */
class ModuleDependencies {
	constructor(options) {
		this.options = options;
		this.edges = new Map();
	}

	/**
	 * Parse the source language, including Vue script blocks and Flow JavaScript.
	 * @param {String} filename
	 * @param {String} content
	 * @param {Object} options
	 * @return {Array}
	 */
	static read(filename, content, options = {}) {
		if (path.extname(filename) === '.vue') {
			return this.readVue(filename, content, options);
		}
		const reader = new ModuleDependencies(options);
		reader.walk(this.parse(filename, content));
		return [...reader.edges.values()].sort((left, right) => left.specifier.localeCompare(right.specifier));
	}

	/**
	 * @return {Object} Source AST; parse failures are never converted into an empty graph.
	 * @param {String} filename
	 * @param {String} content
	 */
	static parse(filename, content) {
		const parsed = parseSync(filename, content, {sourceType: 'unambiguous'});
		if (parsed.errors.length === 0) {
			return parsed.program;
		}
		if (/\.[cm]?jsx?$/.test(filename)) {
			return babel.parse(content, {
				sourceType: 'unambiguous',
				plugins: ['flow', 'jsx', 'decorators-legacy', 'exportDefaultFrom']
			}).program;
		}
		throw new SyntaxError(`${filename}: ${parsed.errors.map((error) => error.message).join('; ')}`);
	}

	/**
	 * @return {Array} Edges from every script block, including TypeScript setup scripts.
	 * @param {String} filename
	 * @param {String} content
	 * @param {Object} options
	 */
	static readVue(filename, content, options) {
		const result = [];
		for (const match of content.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
			const extension = /\blang\s*=\s*['"]tsx?['"]/i.test(match[1]) ? '.tsx' : '.jsx';
			result.push(...this.read(filename + extension, match[2], options));
		}
		return result;
	}

	/**
	 * Add only literal specifiers; computed imports cannot be statically resolved.
	 * @param {Object} node
	 * @param {String} kind
	 */
	add(node, kind = 'import') {
		if (node && typeof node.value === 'string') {
			this.edges.set(kind + ':' + node.value, {specifier: node.value, kind});
		} else if (node && node.type === 'TemplateLiteral' && node.expressions.length === 0) {
			const value = node.quasis[0]?.value.cooked;
			if (typeof value === 'string') {
				this.edges.set(kind + ':' + value, {specifier: value, kind});
			}
		}
	}

	/**
	 * Follow AST children iteratively so deeply nested source cannot overflow the walker.
	 * @param {Object} program
	 */
	walk(program) {
		const pending = [program];
		while (pending.length !== 0) {
			const node = pending.pop();
			this.visit(node);
			for (const key of visitorKeys[node.type] ?? Object.keys(node)) {
				const child = node[key];
				if (Array.isArray(child)) {
					pending.push(...child.filter((entry) => entry && typeof entry.type === 'string'));
				} else if (child && typeof child.type === 'string') {
					pending.push(child);
				}
			}
		}
	}

	/**
	 * Include erased type edges and literal dynamic imports by default.
	 * @param {Object} node
	 */
	visit(node) {
		if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)) {
			this.visitDeclaration(node);
		} else if (node.type === 'TSImportType' && !this.options.skipTypeImports) {
			this.add(node.source ?? node.argument ?? node.parameter, 'type');
		} else if (node.type === 'TSExternalModuleReference') {
			this.add(node.expression, 'require');
		} else if (node.type === 'ImportExpression' && !this.options.skipAsyncImports) {
			this.add(node.source);
		} else if (node.type === 'CallExpression') {
			this.visitCall(node);
		}
	}

	/** Include declaration sources unless callers explicitly request erased-type filtering.
	 * @param {Object} node
	 */
	visitDeclaration(node) {
		if (!this.options.skipTypeImports || (node.importKind !== 'type' && node.exportKind !== 'type')) {
			this.add(node.source, this.typeDeclaration(node) ? 'type' : 'import');
		}
	}

	/** @param {Object} node
	 * @return {Boolean} Type-only edges resolve package declarations rather than requiring runtime exports.
	 */
	typeDeclaration(node) {
		return node.importKind === 'type' || node.exportKind === 'type' ||
			(node.specifiers?.length > 0 && node.specifiers.every((specifier) => specifier.importKind === 'type' || specifier.exportKind === 'type'));
	}

	/**
	 * Recognize CommonJS, RequireJS and AMD dependency arrays.
	 * @param {Object} node
	 */
	visitCall(node) {
		if (node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments.length === 1) {
			this.add(node.arguments[0], 'require');
		}
		if (['define', 'require', 'requirejs'].includes(node.callee.name)) {
			for (const argument of node.arguments) {
				if (argument.type === 'ArrayExpression') {
					this.visitAmd(argument.elements);
				}
			}
		}
	}

	/**
	 * Ignore AMD loader sentinels rather than treating them as filesystem imports.
	 * @param {Object} elements
	 */
	visitAmd(elements) {
		for (const element of elements) {
			if (element && !['require', 'exports', 'module'].includes(element.value)) {
				this.add(element, 'amd');
			}
		}
	}
}

module.exports = ModuleDependencies;
