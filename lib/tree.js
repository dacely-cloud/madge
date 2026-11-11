'use strict';

const os = require('os');
const path = require('path');
const {promisify} = require('util');
const commondir = require('commondir');
const fs = require('node:fs/promises');
const ignore = require('ignore');
const DependencyGraph = require('./dependency-graph');
const log = require('./log');

const stat = promisify(require('fs').stat);

/**
 * Check if running on Windows.
 * @type {Boolean}
 */
const isWin = (os.platform() === 'win32');

class Tree {
	/**
	 * Class constructor.
	 * @constructor
	 * @api public
	 * @param {Array} srcPaths
	 * @param {Object} config
	 * @return {Promise}
	 */
	constructor(srcPaths, config) {
		this.srcPaths = srcPaths.map((s) => path.resolve(s));
		log('using src paths %o', this.srcPaths);

		this.config = config;
		log('using config %o', this.config);

		return this.getDirs()
			.then(this.setBaseDir.bind(this))
			.then(this.getFiles.bind(this))
			.then(this.generateTree.bind(this));
	}

	/**
	 * Set the base directory (compute the common one if multiple).
	 * @param {Array} dirs
	 */
	setBaseDir(dirs) {
		if (this.config.baseDir) {
			this.baseDir = path.resolve(this.config.baseDir);
		} else {
			this.baseDir = commondir(dirs);
		}

		log('using base directory %s', this.baseDir);
	}

	/**
	 * Get directories from the source paths
	 * @return {Promise} resolved with an array of directories
	 */
	getDirs() {
		return Promise
			.all(this.srcPaths.map((srcPath) => {
				return stat(srcPath)
					.then((stats) => stats.isDirectory() ? srcPath : path.dirname(path.resolve(srcPath)));
			}));
	}

	/**
	 * Get all files found from the source paths
	 * @return {Promise} resolved with an array of files
	 */
	async getFiles() {
		const files = new Set();
		for (const srcPath of this.srcPaths) {
			const stats = await stat(srcPath);
			if (this.isGitPath(srcPath)) {
				continue;
			}
			if (stats.isFile()) {
				files.add(srcPath);
			} else {
				await this.walkDirectory(srcPath, [], files);
			}
		}
		return [...files];
	}

	/**
	 * Prune generated and installed trees before opening them; no Git executable is required.
	 * @param {String} directory
	 * @param {Array} inherited
	 * @param {Set} files
	 */
	async walkDirectory(directory, inherited, files) {
		const rules = await this.ignoreRules(directory, inherited);
		for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
			const filename = path.join(directory, entry.name);
			if (this.isGitPath(filename) || this.isNpmPath(filename) || this.ignored(filename, entry.isDirectory(), rules)) {
				continue;
			}
			if (entry.isDirectory()) {
				await this.walkDirectory(filename, rules, files);
			} else if (entry.isFile() && this.config.fileExtensions.includes(path.extname(filename).slice(1))) {
				files.add(filename);
			}
		}
	}

	/**
	 * Read optional nested ignore files without treating permission failures as an empty scan.
	 * @param {String} directory
	 * @param {Array} inherited
	 * @return {Promise}
	 */
	async ignoreRules(directory, inherited) {
		if (!this.config.respectGitIgnore) {
			return inherited;
		}
		try {
			const content = await fs.readFile(path.join(directory, '.gitignore'), 'utf8');
			return [...inherited, {directory, matcher: ignore().add(content)}];
		} catch (error) {
			if (error.code !== 'ENOENT') {
				throw error;
			}
			return inherited;
		}
	}

	/**
	 * Apply child overrides in order, including negated file patterns.
	 * @param {String} filename
	 * @param {Boolean} directory
	 * @param {Array} rules
	 * @return {Boolean}
	 */
	ignored(filename, directory, rules) {
		let ignored = false;
		for (const rule of rules) {
			const relative = path.relative(rule.directory, filename).split(path.sep).join('/') + (directory ? '/' : '');
			const result = rule.matcher.test(relative);
			if (result.ignored || result.unignored) {
				ignored = result.ignored;
			}
		}
		return ignored;
	}

	/**
	 * Generate the tree from the given files
	 * @param  {Array} files
	 * @return {Object}
	 */
	async generateTree(files) {
		const pathCache = {};
		const {graph, skipped} = await new DependencyGraph(this.config, this.baseDir).build(files);
		let tree = Object.create(null);
		for (const [file, dependencies] of Object.entries(graph)) {
			tree[this.processPath(file, pathCache)] = dependencies.map((dependency) => this.processPath(dependency, pathCache));
		}

		if (this.config.excludeRegExp) {
			tree = this.exclude(tree, this.config.excludeRegExp);
		}

		return {
			tree: this.sort(tree),
			skipped
		};
	}

	/**
	 * Process absolute path and return a shorter one.
	 * @param  {String} absPath
	 * @param  {Object} cache
	 * @return {String}
	 */
	processPath(absPath, cache) {
		if (cache[absPath]) {
			return cache[absPath];
		}

		let relPath = path.relative(this.baseDir, absPath);

		if (isWin) {
			relPath = relPath.replace(/\\/g, '/');
		}

		cache[absPath] = relPath;

		return relPath;
	}

	/**
	 * Check if path is from NPM folder
	 * @param  {String} path
	 * @return {Boolean}
	 */
	isNpmPath(path) {
		return path.split(/[\\/]/).includes('node_modules');
	}

	/**
	 * Check if path is from .git folder
	 * @param  {String} filePath
	 * @return {Boolean}
	 */
	isGitPath(filePath) {
		return filePath.split(path.sep).indexOf('.git') !== -1;
	}

	/**
	 * Exclude modules from tree using RegExp.
	 * @param  {Object} tree
	 * @param  {Array} excludeRegExp
	 * @return {Object}
	 */
	exclude(tree, excludeRegExp) {
		const regExpList = excludeRegExp.map((re) => new RegExp(re));

		function regExpFilter(id) {
			return regExpList.findIndex((regexp) => regexp.test(id)) < 0;
		}

		return Object
			.keys(tree)
			.filter(regExpFilter)
			.reduce((acc, id) => {
				acc[id] = tree[id].filter(regExpFilter);
				return acc;
			}, {});
	}

	/**
	 * Sort tree.
	 * @param  {Object} tree
	 * @return {Object}
	 */
	sort(tree) {
		return Object
			.keys(tree)
			.sort()
			.reduce((acc, id) => {
				acc[id] = tree[id].sort();
				return acc;
			}, {});
	}
}

/**
 * Expose API.
 * @param {Array} srcPaths
 * @param {Object} config
 * @return {Promise}
 */
module.exports = (srcPaths, config) => new Tree(srcPaths, config);
