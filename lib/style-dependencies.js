'use strict';

const path = require('node:path');
const sass = require('sass-lookup').default;
const stylus = require('stylus-lookup').default;

/** Preserve stylesheet graphs without installing or loading a JavaScript TypeScript compiler. */
class StyleDependencies {
	static read(filename, content, directory, config) {
		const extension = path.extname(filename);
		const detectors = {'.sass': 'detective-sass', '.scss': 'detective-scss', '.less': '@dependents/detective-less', '.styl': 'detective-stylus'};
		const detector = detectors[extension];
		if (!detector) {
			return null;
		}
		const extract = require(detector).default;
		const lookup = extension === '.styl' ? stylus : sass;
		return extract(content).map((dependency) => ({specifier: dependency, resolved: lookup({dependency, filename, directory, webpackConfig: config.webpackConfig})}));
	}
}

module.exports = StyleDependencies;
