'use strict';

const {readFile} = require('node:fs/promises');
const path = require('node:path');
const ModuleDependencies = require('./module-dependencies');
const ModuleResolver = require('./module-resolver');
const StyleDependencies = require('./style-dependencies');

/** Visit each source once, with a flat graph and explicit failures for incomplete strict scans. */
class DependencyGraph {
	constructor(config, directory) {
		this.config = config;
		this.directory = directory;
		this.resolver = new ModuleResolver(config, directory);
		this.skipped = new Set();
		this.patterns = (config.excludeRegExp || []).map((pattern) => new RegExp(pattern));
	}

	/**
	 * Build the graph, including imports erased from emitted JavaScript.
	 * @param {Array} files
	 * @return {Object}
	 */
	async build(files) {
		const graph = Object.create(null);
		const pending = [...files];
		while (pending.length !== 0) {
			const file = pending.pop();
			if (Object.hasOwn(graph, file) || this.excluded(file)) {
				continue;
			}
			graph[file] = await this.edges(file);
			for (const target of graph[file]) {
				if (!this.isNpm(target)) {
					pending.push(target);
				}
			}
		}
		return {graph, skipped: [...this.skipped]};
	}

	/**
	 * @return {Array} Parse once; strict mode propagates a useful source filename.
	 * @param {String} file
	 */
	async dependencies(file) {
		if (file.includes('?') || !/\.(?:[cm]?[jt]sx?|vue|sass|scss|less|styl)$/.test(file)) {
			return [];
		}
		try {
			const content = await readFile(file, 'utf8');
			const styles = StyleDependencies.read(file, content, this.directory, this.config);
			const options = /\.[cm]?tsx?$/.test(file) ? this.config.detectiveOptions?.ts : this.config.detectiveOptions?.es6;
			return styles ?? ModuleDependencies.read(file, content, options);
		} catch (error) {
			if (this.config.strict) {
				throw new Error(`Cannot analyze ${file}: ${error.message}`, {cause: error});
			}
			this.skipped.add(file);
			return [];
		}
	}

	/**
	 * @return {Array} Resolve admitted dependencies, retaining shallow npm edges only when requested.
	 * @param {String} file
	 */
	async edges(file) {
		const edges = new Set();
		for (const edge of await this.dependencies(file)) {
			const target = this.target(file, edge);
			if (!target || this.excluded(target)) {
				continue;
			}
			if (this.isNpm(target)) {
				if (this.config.includeNpm) {
					edges.add(target);
				}
			} else if (typeof this.config.dependencyFilter !== 'function' || this.config.dependencyFilter(target, file, this.directory) !== false) {
				edges.add(target);
			}
		}
		return [...edges];
	}

	/**
	 * @return {String|undefined} Missing local paths fail strict scans rather than hiding graph edges.
	 * @param {String} file
	 * @param {Object} edge
	 */
	target(file, edge) {
		const result = Object.hasOwn(edge, 'resolved') ? {path: edge.resolved} : this.resolver.resolve(file, edge);
		if (result.external) {
			return;
		}
		if (result.path) {
			return result.path;
		}
		if (this.config.strict) {
			throw new Error(`Cannot resolve ${JSON.stringify(edge.specifier)} imported by ${file}: ${result.error ?? 'not found'}`);
		}
		this.skipped.add(edge.specifier);
	}

	/**
	 * @return {Boolean} Exclusions use the relative names exposed by the public graph.
	 * @param {String} file
	 */
	excluded(file) {
		if (file.split(path.sep).includes('.git')) {
			return true;
		}
		const relative = path.relative(this.directory, file).split(path.sep).join('/');
		return this.patterns.some((pattern) => pattern.test(relative));
	}

	/**
	 * @return {Boolean} Installed packages remain outside the traversed project graph.
	 * @param {String} file
	 */
	isNpm(file) {
		return file.split(path.sep).includes('node_modules');
	}
}

module.exports = DependencyGraph;
