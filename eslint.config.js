'use strict';

const aptoma = require('@aptoma/eslint-config');
const globals = require('globals');

module.exports = [
	{
		files: ['**/*.js'],
		languageOptions: {
			ecmaVersion: 2021,
			sourceType: 'commonjs',
			globals: globals.node
		},
		rules: aptoma.rules
	},
	{
		files: ['test/*.js'],
		languageOptions: {
			globals: globals.mocha
		}
	}
];
