'use strict';

const path = require('node:path');
const {isBuiltin} = require('node:module');
const {ResolverFactory} = require('oxc-resolver');
const amd = require('module-lookup-amd').default;

/** Native resolution supports tsconfig inheritance and emitted JavaScript import names. */
class ModuleResolver {
	constructor(config, directory) {
		this.config = config;
		this.directory = directory;
		this.inline = typeof config.tsConfig === 'object' ? config.tsConfig?.compilerOptions : null;
		const webpack = typeof config.webpackConfig === 'string' ? require(path.resolve(config.webpackConfig)) : config.webpackConfig;
		const alias = Object.fromEntries(Object.entries(webpack?.resolve?.alias ?? {}).map(([key, value]) => [key, [value].flat()]));
		const options = {
			extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.vue', '.node'],
			extensionAlias: {'.js': ['.ts', '.tsx', '.d.ts', '.js'], '.jsx': ['.tsx', '.jsx'], '.mjs': ['.mts', '.d.mts', '.mjs'], '.cjs': ['.cts', '.d.cts', '.cjs']},
			mainFields: ['module', 'main'],
			alias,
			modules: [...(webpack?.resolve?.root ? [webpack.resolve.root].flat() : []), 'node_modules'],
			...(typeof config.tsConfig === 'string' ? {tsconfig: {configFile: path.resolve(config.tsConfig), references: 'auto'}} : {})
		};
		this.imports = new ResolverFactory({...options, conditionNames: ['import', 'node', 'default']});
		this.requires = this.imports.cloneWithOptions({...options, conditionNames: ['require', 'node', 'default']});
	}

	/**
	 * Resolve a module edge; builtins and loader-only AMD plugins are external.
	 * @param {String} filename
	 * @param {Object} edge
	 * @return {Object}
	 */
	resolve(filename, edge) {
		const name = edge.specifier;
		if (isBuiltin(name) || /^(?:https?:|data:)/.test(name) || (this.config.externalModules ?? []).includes(name)) {
			return {external: true};
		}
		if (edge.kind === 'amd') {
			return this.resolveAmd(filename, name);
		}
		const resolver = edge.kind === 'require' ? this.requires : this.imports;
		const inline = this.resolveInline(resolver, name);
		if (inline) {
			return inline;
		}
		return this.resolveModule(resolver, filename, name);
	}

	/**
	 * @return {Object} RequireJS has its own aliases and loader plugin syntax.
	 * @param {String} filename
	 * @param {String} name
	 */
	resolveAmd(filename, name) {
		if (name.includes('!')) {
			return {external: true};
		}
		const resolved = amd({partial: name, filename, directory: this.directory, config: this.config.requireConfig});
		return resolved ? {path: resolved} : {error: `Cannot resolve ${name}`};
	}

	/**
	 * @return {Object} Preserve query suffixes as leaf resource identifiers.
	 * @param {Object} resolver
	 * @param {String} filename
	 * @param {String} name
	 */
	resolveModule(resolver, filename, name) {
		const query = name.indexOf('?');
		let result = resolver.sync(path.dirname(filename), query < 0 ? name : name.slice(0, query));
		if (!result.path && !name.startsWith('.') && !path.isAbsolute(name)) {
			result = resolver.sync(this.directory, './' + name);
		}
		return result.path && query >= 0 ? {...result, path: result.path + name.slice(query)} : result;
	}

	/**
	 * @return {Object|undefined} In-memory configurations remain supported without loading a compiler.
	 * @param {Object} resolver
	 * @param {String} name
	 */
	resolveInline(resolver, name) {
		if (!this.inline) {
			return;
		}
		const base = path.resolve(this.inline.baseUrl ?? this.directory);
		for (const [pattern, replacements] of Object.entries(this.inline.paths ?? {})) {
			const matched = this.match(pattern, name);
			if (matched === null) {
				continue;
			}
			for (const replacement of replacements) {
				const result = resolver.sync(base, path.resolve(base, replacement.replace('*', matched)));
				if (result.path) {
					return result;
				}
			}
		}
		return this.resolveBaseUrl(resolver, base, name);
	}

	/** Resolve bare specifiers relative to an explicitly configured base directory.
	 * @param {Object} resolver
	 * @param {String} base
	 * @param {String} name
	 * @return {Object|undefined}
	 */
	resolveBaseUrl(resolver, base, name) {
		if (this.inline.baseUrl && !name.startsWith('.') && !path.isAbsolute(name)) {
			const result = resolver.sync(base, './' + name);
			if (result.path) {
				return result;
			}
		}
	}

	/**
	 * @return {String|null} Extract a paths wildcard only when both its prefix and suffix match.
	 * @param {String} pattern
	 * @param {String} name
	 */
	match(pattern, name) {
		const star = pattern.indexOf('*');
		if (star < 0) {
			return name === pattern ? '' : null;
		}
		const suffix = pattern.slice(star + 1);
		if (!name.startsWith(pattern.slice(0, star)) || !name.endsWith(suffix) || name.length < pattern.length - 1) {
			return null;
		}
		return name.slice(star, name.length - suffix.length);
	}
}

module.exports = ModuleResolver;
